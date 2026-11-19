import { diagnostic } from "../diagnostics/index.ts";
import type { Diagnostic } from "../diagnostics/index.ts";
import { nodeToMap } from "../model/proxy-node.ts";
import type { ProxyNode } from "../model/proxy-node.ts";
import { encodeNodeWithReport } from "../subscription-import/encode.ts";
import type { FieldCompatibilityStatus, NodeMap } from "../subscription-import/encode.ts";
import { validateProxyNode } from "../validation/index.ts";

export type ConversionStatus = "complete" | "lossy" | "unsupported" | "invalid";

export interface FieldCompatibilityRecord {
  field: string;
  status: FieldCompatibilityStatus;
  reason?: string;
}

export interface EncodedProxyNode {
  node: ProxyNode;
  uri: string | null;
  status: ConversionStatus;
  diagnostics: Diagnostic[];
  fieldCompatibility: FieldCompatibilityRecord[];
}

type FieldValueMap = Map<string, unknown>;

function normalizeSegment(value: string): string {
  return value.toLowerCase().replace(/[-_]/g, "");
}

function normalizePath(value: string): string {
  return value.split(".").map(normalizeSegment).join(".");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function collectFields(value: NodeMap, output: FieldValueMap, expandNested = true): void {
  const visit = (child: unknown, path: string, ancestors: WeakSet<object>) => {
    if (expandNested && isRecord(child) && Object.keys(child).length > 0 && !ancestors.has(child)) {
      ancestors.add(child);
      for (const [key, nested] of Object.entries(child)) visit(nested, path ? `${path}.${key}` : key, ancestors);
      ancestors.delete(child);
      return;
    }
    output.set(path, child);
  };
  for (const [key, child] of Object.entries(value)) visit(child, key, new WeakSet());
}

function semanticEqual(left: unknown, right: unknown, seen = new WeakMap<object, WeakSet<object>>()): boolean {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  const prior = seen.get(left);
  if (prior?.has(right)) return true;
  if (prior) prior.add(right);
  else seen.set(left, new WeakSet([right]));
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right)
      && left.length === right.length
      && left.every((item, index) => semanticEqual(item, right[index], seen));
  }
  const a = Object.keys(left as NodeMap).sort();
  const b = Object.keys(right as NodeMap).sort();
  return a.length === b.length && a.every((key, index) => key === b[index]
    && semanticEqual((left as NodeMap)[key], (right as NodeMap)[key], seen));
}

function scalar(value: unknown): string {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value).trim() : "";
}

function boolValue(value: unknown): boolean | undefined {
  const token = scalar(value).toLowerCase();
  if (["true", "1", "yes", "on"].includes(token)) return true;
  if (["false", "0", "no", "off"].includes(token)) return false;
  return undefined;
}

function numberValue(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(scalar(value));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function conflictValue(path: string, value: unknown): string {
  if (/password|passwd|pwd|uuid|token|secret|private.?key|auth|credential|username|access.?key/i.test(path)) return "[redacted]";
  if (typeof value === "string" && /[a-z][a-z0-9+.-]*:\/\//i.test(value)) return "[URI omitted]";
  if (typeof value === "string" && value.length <= 120) return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return JSON.stringify(value);
  return `[${Array.isArray(value) ? "list" : typeof value}]`;
}

function listValues(value: unknown): string[] {
  const values = Array.isArray(value) ? value.map(scalar) : scalar(value).split(",");
  return values.map(item => item.trim().toLowerCase()).filter(Boolean);
}

const TLS_FIELDS = new Set([
  "tls", "sni", "servername", "server_name", "server-name", "alpn", "client-fingerprint", "client_fingerprint",
  "skip-cert-verify", "skip_cert_verify", "allowInsecure", "insecure", "ech-opts", "ech_opts", "echEnabled",
  "echConfigList", "echQueryServerName", "certificate", "cert", "fragment", "fragment_fallback_delay",
  "fragment-fallback-delay", "record_fragment", "record-fragment", "fingerprint", "certificate-public-key-sha256",
  "certificate_public_key_sha256", "tls-min-version", "tls-max-version", "min-version", "max-version",
  "min_version", "max_version",
]);
const TLS_URI_PROTOCOLS = new Set(["vmess", "vless", "trojan", "hysteria2", "anytls", "tuic", "naive", "masque"]);
const TRANSPORT_URI_PROTOCOLS = new Set(["vmess", "vless", "trojan"]);

function defaultOmitted(path: string, value: unknown, node: ProxyNode): boolean {
  const segments = path.split(".");
  const key = segments[segments.length - 1] ?? path;
  const normalizedKey = normalizeSegment(key);
  if (value === "" || value === null || value === undefined || (Array.isArray(value) && value.length === 0)) return true;
  const boolean = boolValue(value);
  if (boolean === false && [
    "tls", "skipcertverify", "allowinsecure", "insecure", "reducertt", "udpovertcp", "v2rayhttpupgrade",
  ].includes(normalizedKey)) return true;
  if (node.protocol === "vless" && ["up", "down"].includes(normalizedKey) && numberValue(value) === 0) return true;
  return false;
}

function nestedNetworkOptions(path: string): string | null {
  const root = normalizeSegment(path.split(".")[0] ?? "");
  if (["wsopts"].includes(root)) return "ws";
  if (["grpcopts"].includes(root)) return "grpc";
  if (["h2opts", "httpopts"].includes(root)) return "http";
  if (["httpupgradeopts"].includes(root)) return "httpupgrade";
  if (["xhttpopts"].includes(root)) return "xhttp";
  return null;
}

function normalizeNetwork(value: unknown): string {
  const network = scalar(value).toLowerCase();
  return ({ "": "tcp", raw: "tcp", none: "tcp", h2: "http", "http-upgrade": "httpupgrade", splithttp: "xhttp" } as Record<string, string>)[network] ?? network;
}

function classificationForUnencodedField(
  path: string,
  value: unknown,
  node: ProxyNode,
  allFields: FieldValueMap,
  encodedPaths: Set<string>,
): { status: FieldCompatibilityStatus; reason: string } {
  const root = path.split(".")[0] ?? path;
  const key = root.toLowerCase();
  const normalizedKey = normalizeSegment(root);
  const setting = node.settings;
  const network = normalizeNetwork(setting.network);

  // Aliases with the same normalized spelling share the encoder's actual lookup.
  const consumedAlias = [...encodedPaths].find(encoded => normalizePath(encoded) === normalizePath(path));
  if (consumedAlias) {
    const encodedValue = allFields.get(consumedAlias);
    if (semanticEqual(value, encodedValue)) return { status: "equivalent", reason: "An equivalent spelling was consumed by the URI encoder." };
    return { status: "conflict", reason: `The encoded alias ${consumedAlias}=${conflictValue(consumedAlias, encodedValue)} conflicts with ${path}=${conflictValue(path, value)}; the URI can carry only one value.` };
  }

  const sniAliases = new Set(["servername", "sni", "server_name", "server-name"]);
  if (!path.includes(".") && sniAliases.has(key)) {
    const encodedSni = [...encodedPaths].find(candidate => !candidate.includes(".") && sniAliases.has(candidate.toLowerCase()));
    if (encodedSni) {
      if (semanticEqual(value, allFields.get(encodedSni))) return { status: "equivalent", reason: "The SNI alias has the same value as the field encoded in the URI." };
      return { status: "conflict", reason: `${encodedSni}=${conflictValue(encodedSni, allFields.get(encodedSni))} conflicts with ${path}=${conflictValue(path, value)}; the URI carries only one SNI value.` };
    }
  }

  if (node.protocol === "ss" && !path.includes(".") && normalizedKey === "method" && allFields.has("cipher")) {
    const cipher = allFields.get("cipher");
    if (semanticEqual(value, cipher)) return { status: "equivalent", reason: `Shadowsocks method ${conflictValue(path, value)} matches the cipher field consumed by the URI encoder.` };
    return { status: "conflict", reason: `Shadowsocks method=${conflictValue(path, value)} conflicts with cipher=${conflictValue("cipher", cipher)}; the URI encoder uses cipher.` };
  }

  if (normalizePath(path) === "realityopts.supportx25519mlkem768") {
    if (node.protocol !== "vless") return { status: "not_applicable", reason: "support-x25519mlkem768 applies only to VLESS REALITY." };
    if (boolValue(value) === undefined) return { status: "not_representable", reason: "VLESS REALITY support-x25519mlkem768 must be a boolean value." };
    return { status: "not_representable", reason: "The VLESS REALITY boolean was not consumed by the URI encoder." };
  }
  if (!path.includes(".") && normalizedKey === "supportx25519mlkem768") {
    const reality = isRecord(setting["reality-opts"]) && Object.keys(setting["reality-opts"] as NodeMap).length > 0;
    if (node.protocol !== "vless" || !reality) return { status: "not_applicable", reason: "support-x25519mlkem768 is meaningful only inside VLESS reality-opts." };
    if (boolValue(value) === undefined) return { status: "not_representable", reason: "VLESS REALITY support-x25519mlkem768 must be a boolean value." };
    return { status: "not_representable", reason: "The option must be nested under reality-opts to be encoded for VLESS REALITY." };
  }

  if (!path.includes(".") && normalizedKey === "dialerproxy") {
    return { status: "not_representable", reason: "A single-node URI cannot carry the dialer-proxy chain or its outbound dependency." };
  }

  if (node.protocol === "vmess" && network === "ws" && !path.includes(".") && normalizedKey === "wspath") {
    const nestedPath = setting["ws-opts"] && isRecord(setting["ws-opts"]) ? setting["ws-opts"].path
      : setting.ws_opts && isRecord(setting.ws_opts) ? setting.ws_opts.path : undefined;
    if (nestedPath !== undefined && scalar(nestedPath) !== scalar(value)) {
      return { status: "not_representable", reason: "ws-opts.path takes precedence; the conflicting top-level ws-path value is not represented." };
    }
    if (nestedPath !== undefined) return { status: "equivalent", reason: "ws-path matches the nested WebSocket path encoded in the URI." };
  }

  if (!path.includes(".") && normalizedKey === "udp") {
    const enabled = boolValue(value);
    if (node.protocol === "socks4" || node.protocol === "socks4a") {
      return { status: "not_applicable", reason: "SOCKS4 does not provide the UDP association used by this setting." };
    }
    if (enabled === true) return { status: "equivalent", reason: "The URI scheme leaves UDP forwarding at the target client's normal enabled behavior." };
    if (enabled === false) return { status: "not_representable", reason: "The URI scheme has no parameter for explicitly disabling UDP forwarding." };
  }

  if (node.protocol === "vless" && !path.includes(".") && ["alterid", "alter_id", "alter-id"].includes(key)) {
    if (numberValue(value) === 0) return { status: "not_applicable", reason: "VLESS does not use the VMess alterId field; zero is an inert compatibility value." };
    return { status: "not_representable", reason: "VLESS does not use alterId and a non-zero value cannot be represented." };
  }
  if (node.protocol === "vless" && !path.includes(".") && key === "cipher") {
    if (scalar(value).toLowerCase() === "auto") return { status: "default_omitted", reason: "VLESS auto is a placeholder and has no separate cipher setting in the target URI." };
    return { status: "not_representable", reason: "VLESS cipher values other than auto are not expressible by this target URI." };
  }

  if (node.protocol === "hysteria2" && !path.includes(".") && ["up", "down", "up_mbps", "down_mbps", "upmbps", "downmbps"].includes(normalizedKey)) {
    if (numberValue(value) === 0) return { status: "default_omitted", reason: "A zero bandwidth limit is equivalent to leaving the limit unset." };
    return { status: "not_representable", reason: "The Hysteria2 sharing URI format does not define bandwidth parameters." };
  }
  if (node.protocol === "hysteria2" && !path.includes(".") && ["hopinterval", "mport"].includes(normalizedKey)) {
    return { status: "not_representable", reason: `The Hysteria2 sharing URI does not define the ${path} query parameter.` };
  }
  if (node.protocol === "tuic" && !path.includes(".") && normalizedKey === "maxudprelaypacketsize") {
    return { status: "not_representable", reason: "max-udp-relay-packet-size is a client configuration field with no established TUIC sharing URI parameter; adding a private query key would not be interoperable." };
  }

  if (!path.includes(".") && normalizedKey === "tls" && ["hysteria2", "anytls", "tuic", "naive", "masque"].includes(node.protocol)) {
    if (boolValue(value) === true) return { status: "equivalent", reason: `TLS is inherent in the ${node.protocol} URI scheme.` };
    if (boolValue(value) === false) return { status: "not_representable", reason: `The ${node.protocol} URI scheme requires TLS and cannot express tls=false.` };
  }
  if (!path.includes(".") && normalizedKey === "tls" && node.protocol === "vless" && boolValue(value) === true
    && isRecord(setting["reality-opts"]) && Object.keys(setting["reality-opts"] as NodeMap).length > 0) {
    return { status: "equivalent", reason: "REALITY transport implies TLS, so the security=reality URI carries this setting." };
  }

  if (node.protocol === "hysteria2" && !path.includes(".") && normalizedKey === "alpn") {
    if (semanticEqual(listValues(value), ["h3"])) {
      return { status: "default_omitted", reason: "Hysteria2 clients use h3 by default, matching this ALPN list; the standard sharing URI omits ALPN." };
    }
    return { status: "not_representable", reason: "The Hysteria2 sharing URI does not define an ALPN parameter; only the protocol's h3 default can be omitted safely." };
  }
  if (node.protocol === "hysteria2" && (
    ["clientfingerprint", "certificate", "cert", "fragment", "fragmentfallbackdelay", "recordfragment",
      "certificatepublickeysha256", "tlsminversion", "tlsmaxversion", "minversion", "maxversion", "echqueryservername"].includes(normalizedKey)
    || normalizePath(path) === "echopts.queryservername"
  )) {
    return { status: "not_representable", reason: `The Hysteria2 sharing URI does not define a parameter for ${path}.` };
  }

  if (!path.includes(".") && normalizedKey === "mode") {
    if (node.protocol === "vless" && network === "tcp" && scalar(value).toLowerCase() === "multi") {
      return { status: "not_applicable", reason: "VLESS mode=multi selects XHTTP behavior and has no meaning on the configured TCP transport." };
    }
    if (network === "xhttp" && node.protocol === "vless") {
      const xhttp = isRecord(setting["xhttp-opts"]) ? setting["xhttp-opts"] as NodeMap : {};
      if (xhttp.mode !== undefined) {
        if (semanticEqual(value, xhttp.mode)) return { status: "equivalent", reason: "The top-level mode matches xhttp-opts.mode, which is carried in the URI's xhttpOptions." };
        return { status: "conflict", reason: `Top-level mode=${conflictValue(path, value)} conflicts with xhttp-opts.mode=${conflictValue("xhttp-opts.mode", xhttp.mode)}; the nested XHTTP setting is used.` };
      }
      return { status: "not_representable", reason: "XHTTP mode must be carried inside xhttp-opts; no equivalent nested mode was encoded." };
    }
  }

  if (!path.includes(".") && normalizedKey === "network") {
    if (network === "tcp" && !TRANSPORT_URI_PROTOCOLS.has(node.protocol)) {
      return { status: "not_applicable", reason: "TCP is the default transport and is implicit for this URI scheme." };
    }
    if (!TRANSPORT_URI_PROTOCOLS.has(node.protocol) && network !== "tcp") {
      return { status: "not_representable", reason: `The ${node.protocol} URI scheme cannot express the ${network} transport.` };
    }
  }

  const optionNetwork = nestedNetworkOptions(path);
  if (optionNetwork) {
    if (optionNetwork !== network) return { status: "not_applicable", reason: `This ${optionNetwork} option is inactive while the configured transport is ${network}.` };
    if (!TRANSPORT_URI_PROTOCOLS.has(node.protocol)) {
      return { status: "not_representable", reason: `The ${node.protocol} URI scheme cannot express ${optionNetwork} transport options.` };
    }
  }

  if (TLS_FIELDS.has(root) && !TLS_URI_PROTOCOLS.has(node.protocol)) {
    if (node.protocol === "ss" && setting.plugin) {
      return { status: "not_representable", reason: "The configured Shadowsocks plugin's TLS behavior is not expressed by this URI encoder." };
    }
    return { status: "not_applicable", reason: `TLS settings do not apply to the ${node.protocol} URI scheme.` };
  }

  if (!path.includes(".") && normalizedKey === "cipher" && node.protocol !== "vmess" && node.protocol !== "ss") {
    return { status: "not_applicable", reason: `cipher is not a setting for the ${node.protocol} protocol.` };
  }
  if (!path.includes(".") && ["alterid", "alter_id", "alter-id"].includes(key) && node.protocol !== "vmess") {
    return { status: "not_applicable", reason: `alterId is not a setting for the ${node.protocol} protocol.` };
  }

  return { status: "unknown", reason: "The URI encoder did not consume this field and its protocol semantics are unknown." };
}

function collectCompatibility(
  node: ProxyNode,
  encodedFields: string[],
): FieldCompatibilityRecord[] {
  const extensionValues: FieldValueMap = new Map();
  const settingValues: FieldValueMap = new Map();
  collectFields(node.extensions, extensionValues, false);
  collectFields(node.settings, settingValues);
  const values = new Map([...extensionValues, ...settingValues]);
  const encodedPaths = new Set(encodedFields);
  const result: FieldCompatibilityRecord[] = [];

  for (const [field, value] of values) {
    let status: FieldCompatibilityStatus;
    let reason: string | undefined;
    const sourceCollision = extensionValues.has(field) && settingValues.has(field);
    if (sourceCollision) {
      const extensionValue = extensionValues.get(field);
      const settingValue = settingValues.get(field);
      const encodedSetting = encodedPaths.has(field)
        || [...encodedPaths].some(candidate => normalizePath(candidate) === normalizePath(field));
      if (!semanticEqual(extensionValue, settingValue)) {
        status = "conflict";
        reason = `Extension value ${conflictValue(field, extensionValue)} conflicts with normalized setting value ${conflictValue(field, settingValue)}; the normalized setting is used.`;
        result.push({ field, status, reason });
        continue;
      }
      if (encodedSetting) {
        status = "equivalent";
        reason = `Extension value ${conflictValue(field, extensionValue)} matches the normalized setting and is represented by the URI field.`;
        result.push({ field, status, reason });
        continue;
      }
    }

    if (node.protocol === "ss" && !field.includes(".") && normalizeSegment(field) === "method" && values.has("cipher")) {
      const cipher = values.get("cipher");
      status = semanticEqual(value, cipher) ? "equivalent" : "conflict";
      reason = status === "equivalent"
        ? `Shadowsocks method ${conflictValue(field, value)} matches cipher, which supplies the URI credential.`
        : `Shadowsocks method=${conflictValue(field, value)} conflicts with cipher=${conflictValue("cipher", cipher)}; the URI encoder uses cipher.`;
      result.push({ field, status, reason });
      continue;
    }

    const encodedAlias = encodedPaths.has(field)
      ? field
      : [...encodedPaths].find(candidate => normalizePath(candidate) === normalizePath(field));
    if (encodedAlias) {
      if (encodedAlias !== field) {
        const encodedValue = values.get(encodedAlias);
        status = semanticEqual(value, encodedValue) ? "equivalent" : "conflict";
        reason = status === "equivalent"
          ? "An equivalent field spelling was consumed by the URI encoder."
          : `${encodedAlias}=${conflictValue(encodedAlias, encodedValue)} conflicts with ${field}=${conflictValue(field, value)}; only one alias value can be represented.`;
        result.push({ field, status, reason });
        continue;
      }
      if (node.protocol === "vless" && ["alterid", "alter_id", "alter-id"].includes(field.toLowerCase()) && numberValue(value) === 0) {
        status = "not_applicable";
        reason = "VLESS does not use the VMess alterId field; zero is an inert compatibility value.";
      } else if (node.protocol === "vless" && field.toLowerCase() === "cipher" && scalar(value).toLowerCase() === "auto") {
        status = "default_omitted";
        reason = "VLESS auto is a placeholder and has no separate cipher setting in the target URI.";
      } else if (node.protocol === "hysteria2" && ["echopts.enabled", "echopts.enable", "echenabled"].includes(normalizePath(field))) {
        const ech = isRecord(node.settings["ech-opts"]) ? node.settings["ech-opts"] as NodeMap : {};
        const config = ech.config ?? node.settings.echConfigList ?? node.settings.ech;
        const enabled = boolValue(ech.enabled ?? ech.enable ?? node.settings.echEnabled);
        if (boolValue(value) === false) {
          status = "default_omitted";
          reason = "ECH is explicitly disabled, so its configuration is omitted.";
        } else if (config) {
          status = "equivalent";
          reason = "The Hysteria2 ech query parameter enables the supplied ECH config list.";
        } else if (enabled === true || boolValue(value) === true) {
          status = "not_representable";
          reason = "ECH is enabled without a config list, which the Hysteria2 URI cannot express.";
        } else {
          status = "default_omitted";
          reason = "ECH is disabled by default and has no config list to encode.";
        }
      } else if (node.protocol === "hysteria2" && ["echopts.config", "echconfiglist", "ech"].includes(normalizePath(field))) {
        const ech = isRecord(node.settings["ech-opts"]) ? node.settings["ech-opts"] as NodeMap : {};
        const enabled = boolValue(ech.enabled ?? ech.enable ?? node.settings.echEnabled);
        if (enabled === false) {
          status = "default_omitted";
          reason = "The ECH config is present but disabled, so it has no effect on the target URI.";
        } else {
          status = "encoded";
        }
      } else if (field.toLowerCase() === "tls" && boolValue(value) === false && node.protocol === "vless") {
        status = "equivalent";
        reason = "VLESS security=none carries the same meaning as tls=false.";
      } else if (field.toLowerCase() === "tls" && boolValue(value) === false && node.protocol === "vmess") {
        status = "default_omitted";
        reason = "VMess TLS is disabled by default, so false is safely omitted.";
      } else if (field.toLowerCase() === "tls" && boolValue(value) === true && ["hysteria2", "anytls", "tuic", "naive", "trojan"].includes(node.protocol)) {
        status = "equivalent";
        reason = `TLS is inherent in the ${node.protocol} URI scheme.`;
      } else if (field.toLowerCase() === "tls" && boolValue(value) === false && ["hysteria2", "anytls", "tuic", "naive", "trojan"].includes(node.protocol)) {
        status = "not_representable";
        reason = `The ${node.protocol} URI scheme requires TLS and cannot express tls=false.`;
      } else if (defaultOmitted(field, value, node)) {
        status = "default_omitted";
        reason = "The field contains an omitted empty or disabled default value.";
      } else {
        status = "encoded";
      }
    } else {
      const classified = classificationForUnencodedField(field, value, node, values, encodedPaths);
      status = classified.status;
      reason = classified.reason;
    }
    result.push({ field, status, ...(reason ? { reason } : {}) });
  }
  const activeNetwork = normalizeNetwork(node.settings.network);
  const unsupportedTransportRoots = new Set<string>();
  for (const field of result) {
    const optionNetwork = nestedNetworkOptions(field.field);
    if (optionNetwork && optionNetwork === activeNetwork && !TRANSPORT_URI_PROTOCOLS.has(node.protocol)
      && field.status === "not_representable") {
      unsupportedTransportRoots.add(field.field.split(".")[0]);
    }
  }
  for (const root of unsupportedTransportRoots) {
    result.push({
      field: root,
      status: "not_representable",
      reason: `The ${node.protocol} URI scheme cannot express the active ${activeNetwork} transport options.` ,
    });
  }
  return result;
}

function nodeContext(node: ProxyNode, stage: string) {
  const origin = node.sources[0];
  return {
    sourceId: origin?.sourceId ?? "unknown",
    ...(origin?.location ? { location: origin.location } : {}),
    nodeId: node.id,
    stage,
  };
}

export function encodeProxyNode(node: ProxyNode): EncodedProxyNode {
  const diagnostics = validateProxyNode(node);
  if (diagnostics.some(item => item.severity === "error")) {
    return { node, uri: null, status: "invalid", diagnostics, fieldCompatibility: [] };
  }

  let uri: string | null = null;
  let encodedFields: string[] = [];
  try {
    const proxy = nodeToMap(node);
    if (node.protocol === "naive") proxy.type = "naive";
    const encoded = encodeNodeWithReport(proxy);
    uri = encoded.uri;
    encodedFields = encoded.encodedFields;
  } catch (error) {
    diagnostics.push(diagnostic(
      nodeContext(node, "encode"),
      "encode_exception",
      "error",
      error instanceof Error ? error.message : String(error),
    ));
  }

  const fieldCompatibility = collectCompatibility(node, encodedFields);
  for (const field of fieldCompatibility) {
    if (field.status !== "not_representable" && field.status !== "unknown" && field.status !== "conflict") continue;
    diagnostics.push({
      ...diagnostic(
        nodeContext(node, "encode"),
        "field_not_encoded",
        "warning",
        field.status === "not_representable"
          ? `Field "${field.field}" is not representable in this protocol URI: ${field.reason}`
          : field.status === "conflict"
            ? `Field "${field.field}" conflicts with another source value: ${field.reason}`
            : `Field "${field.field}" was not consumed by the URI encoder: ${field.reason}`,
        field.field,
      ),
      compatibility: field.status,
    });
  }

  if (!uri) {
    diagnostics.push(diagnostic(
      nodeContext(node, "encode"),
      "unsupported_encoding",
      "warning",
      `No URI encoder is available for protocol ${node.protocol}.`,
    ));
    if (diagnostics.some(item => item.severity === "error")) {
      return { node, uri: null, status: "invalid", diagnostics, fieldCompatibility };
    }
    return { node, uri: null, status: "unsupported", diagnostics, fieldCompatibility };
  }
  const lossy = fieldCompatibility.some(field => field.status === "not_representable" || field.status === "unknown" || field.status === "conflict");
  return { node, uri, status: lossy ? "lossy" : "complete", diagnostics, fieldCompatibility };
}

export function encodeProxyNodes(nodes: ProxyNode[]): EncodedProxyNode[] {
  return nodes.map(encodeProxyNode);
}
