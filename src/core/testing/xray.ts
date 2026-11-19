import type { ProxyNode } from "../model/proxy-node.ts";

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function text(value: JsonObject, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const item = value[key];
    if (typeof item === "string" && item.trim()) return item.trim();
    if (typeof item === "number" && Number.isFinite(item)) return String(item);
  }
  return undefined;
}

function list(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).map(item => item.trim()).filter(Boolean);
  return typeof value === "string" ? value.split(",").map(item => item.trim()).filter(Boolean) : [];
}

function enabled(value: unknown): boolean {
  return value === true || value === 1 || (typeof value === "string" && ["true", "1", "yes", "on"].includes(value.toLowerCase()));
}

function required(settings: JsonObject, label: string, ...keys: string[]): string {
  const value = text(settings, ...keys);
  if (!value) throw new Error(`节点缺少 ${label}`);
  return value;
}

const XHTTP_FIELDS = new Set([
  "host", "path", "mode", "headers", "xPaddingBytes", "xPaddingObfsMode", "xPaddingKey",
  "xPaddingHeader", "xPaddingPlacement", "xPaddingMethod", "uplinkHTTPMethod", "sessionIDPlacement",
  "sessionIDKey", "sessionIDTable", "sessionIDLength", "seqPlacement", "seqKey", "uplinkDataPlacement",
  "uplinkDataKey", "uplinkChunkSize", "noGRPCHeader", "noSSEHeader", "scMaxEachPostBytes",
  "scMinPostsIntervalMs", "scMaxBufferedPosts", "scStreamUpServerSecs", "serverMaxHeaderBytes", "xmux",
  "downloadSettings",
]);

function xhttpOptions(settings: JsonObject): JsonObject {
  const raw = settings["xhttp-opts"] ?? settings.xhttp_opts ?? {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("XHTTP 参数必须是对象");
  const options = { ...object(raw) };
  if (typeof options.type === "string" && ["xhttp", "splithttp", "split-http"].includes(options.type.toLowerCase())) delete options.type;
  if (options.extra !== undefined) {
    let extra = options.extra;
    if (typeof extra === "string") {
      try { extra = JSON.parse(extra); } catch { throw new Error("XHTTP extra 不是有效 JSON"); }
    }
    if (!extra || typeof extra !== "object" || Array.isArray(extra)) throw new Error("XHTTP extra 必须是对象");
    delete options.extra;
    for (const [key, value] of Object.entries(extra)) {
      if (key in options && JSON.stringify(options[key]) !== JSON.stringify(value)) {
        throw new Error(`XHTTP 参数 ${key} 与 extra 冲突`);
      }
      options[key] = value;
    }
  }
  for (const key of Object.keys(options)) {
    if (!XHTTP_FIELDS.has(key)) throw new Error(`Xray 不支持 XHTTP 参数：${key}`);
  }
  return options;
}

function buildTls(settings: JsonObject, serverName: string, reality: boolean): JsonObject {
  const ech = object(settings["ech-opts"] ?? settings.ech_opts);
  const echDisabled = ech.enabled === false || ech.enabled === 0 || (typeof ech.enabled === "string" && ["false", "0", "no", "off"].includes(ech.enabled.toLowerCase()));
  const echActive = !echDisabled && (enabled(ech.enabled) || text(ech, "config", "query-server-name", "query_server_name") !== undefined);
  if (reality && echActive) throw new Error("REALITY 与 ECH 不能同时启用");
  const fingerprint = text(settings, "client-fingerprint", "client_fingerprint");
  const sni = text(settings, "sni", "servername", "server_name", "server-name") ?? serverName;
  if (reality) {
    const opts = object(settings["reality-opts"] ?? settings.reality_opts);
    // Xray 在指纹提供混合密钥协商时支持该功能，但不能单独将其关闭。
    const mlkem = opts["support-x25519mlkem768"] ?? opts.support_x25519mlkem768;
    if (mlkem !== undefined && !enabled(mlkem)) {
      throw new Error("Xray 无法按节点设置禁用 REALITY support-x25519mlkem768");
    }
    const publicKey = required(opts, "REALITY 公钥", "public-key", "public_key", "publicKey");
    const spiderX = text(opts, "spider-x", "spider_x", "spiderX", "spx") ?? text(settings, "stream.reality.spiderX");
    const mldsa65Verify = text(opts, "mldsa65Verify", "mldsa65-verify") ?? text(settings, "stream.reality.mldsa65Verify");
    return {
      serverName: sni,
      fingerprint: fingerprint ?? "chrome",
      publicKey,
      ...(text(opts, "short-id", "short_id", "shortId") ? { shortId: text(opts, "short-id", "short_id", "shortId") } : {}),
      ...(spiderX ? { spiderX } : {}),
      ...(mldsa65Verify ? { mldsa65Verify } : {}),
    };
  }
  const pinned = text(settings, "pinSHA256", "pinnedPeerCertSha256", "pcs", "fingerprint");
  const verifyByName = text(settings, "verifyPeerCertByName", "vcn", "stream.tls.verifyPeerCertByName");
  if (settings.certificate !== undefined || settings.cert !== undefined || settings.certificate_public_key_sha256 !== undefined
    || settings["certificate-public-key-sha256"] !== undefined) {
    throw new Error("Xray 测试暂不支持此节点的自定义证书或公钥指纹");
  }
  if (enabled(settings["skip-cert-verify"] ?? settings.skip_cert_verify ?? settings.insecure ?? settings.allowInsecure) && !pinned && !verifyByName) {
    throw new Error("当前 Xray 已移除跳过证书验证，请提供证书指纹或验证名称");
  }
  const alpn = list(settings.alpn);
  const minVersion = text(settings, "tls-min-version", "min-version", "minVersion");
  const maxVersion = text(settings, "tls-max-version", "max-version", "maxVersion");
  const tls: JsonObject = {
    serverName: sni,
    ...(fingerprint ? { fingerprint } : {}),
    ...(alpn.length ? { alpn } : {}),
    ...(pinned ? { pinnedPeerCertSha256: pinned } : {}),
    ...(verifyByName ? { verifyPeerCertByName: verifyByName } : {}),
    ...(minVersion ? { minVersion } : {}),
    ...(maxVersion ? { maxVersion } : {}),
  };
  if (echActive) {
    const config = text(ech, "config");
    const queryName = text(ech, "query-server-name", "query_server_name");
    if (!config) throw new Error(`Xray ECH 需要明确的 ECHConfigList${queryName ? "，不支持仅指定查询域名" : ""}`);
    tls.echConfigList = config.replace(/-----BEGIN ECH CONFIGS-----|-----END ECH CONFIGS-----|\s/g, "");
  }
  return tls;
}

function streamSettings(node: ProxyNode, settings: JsonObject): JsonObject {
  const raw = text(settings, "network", "transport")?.toLowerCase() ?? "tcp";
  const network = ({ raw: "tcp", none: "tcp", splithttp: "xhttp", "split-http": "xhttp", "http-upgrade": "httpupgrade" } as Record<string, string>)[raw] ?? raw;
  const stream: JsonObject = { network };
  if (network === "xhttp") {
    stream.xhttpSettings = xhttpOptions(settings);
  } else if (network === "ws") {
    const opts = object(settings["ws-opts"] ?? settings.ws_opts);
    let path = text(opts, "path") ?? "/";
    const ws: JsonObject = {};
    if (Object.keys(object(opts.headers)).length) ws.headers = opts.headers;
    const early = opts["max-early-data"] ?? opts.max_early_data;
    const earlyHeader = text(opts, "early-data-header-name", "early_data_header_name");
    if (earlyHeader && earlyHeader.toLowerCase() !== "sec-websocket-protocol") throw new Error("Xray 不支持此 WebSocket early data 请求头");
    if (early !== undefined) {
      const amount = Number(early);
      if (!Number.isInteger(amount) || amount < 0) throw new Error("WebSocket early data 长度无效");
      const query = new URLSearchParams(path.split("?", 2)[1] ?? "");
      if (query.has("ed") && query.get("ed") !== String(amount)) throw new Error("WebSocket 路径中的 ed 与节点设置冲突");
      if (!query.has("ed") && amount > 0) path += `${path.includes("?") ? "&" : "?"}ed=${amount}`;
    }
    ws.path = path;
    stream.wsSettings = ws;
  } else if (network === "grpc") {
    const opts = object(settings["grpc-opts"] ?? settings.grpc_opts);
    stream.grpcSettings = {
      ...(text(opts, "grpc-service-name", "service-name", "service_name") ? { serviceName: text(opts, "grpc-service-name", "service-name", "service_name") } : {}),
      ...(text(opts, "authority") ? { authority: text(opts, "authority") } : {}),
      ...(String(settings.mode ?? "").toLowerCase() === "multi" || enabled(opts.multiMode ?? opts.multi_mode) ? { multiMode: true } : {}),
    };
  } else if (network === "httpupgrade") {
    const opts = object(settings["http-upgrade-opts"] ?? settings.http_upgrade_opts);
    stream.httpupgradeSettings = { path: text(opts, "path") ?? "/", ...(text(opts, "host") ? { host: text(opts, "host") } : {}) };
  } else if (network !== "tcp") {
    throw new Error(`Xray 测试暂不支持传输类型：${network}`);
  }
  const reality = settings["reality-opts"] !== undefined || settings.reality_opts !== undefined
    || text(settings, "security")?.toLowerCase() === "reality";
  const tls = reality || settings.tls === true || ["tls", "reality"].includes(String(settings.tls).toLowerCase())
    || text(settings, "security")?.toLowerCase() === "tls" || node.protocol === "trojan";
  if (tls) {
    stream.security = reality ? "reality" : "tls";
    stream[reality ? "realitySettings" : "tlsSettings"] = buildTls(settings, node.server, reality);
  }
  return stream;
}

function masqueOutbound(node: ProxyNode, settings: JsonObject): JsonObject {
  const profile = text(settings, "profile")?.toLowerCase() ?? "cloudflare";
  if (profile !== "cloudflare") throw new Error("Xray 目前只支持 Cloudflare WARP MASQUE 配置");
  for (const key of ["uri", "mtu", "idle_timeout", "idle-timeout", "keep_alive_period", "keep-alive-period", "network_list", "network-list"]) {
    if (settings[key] !== undefined && settings[key] !== "") throw new Error(`Xray MASQUE 暂不支持参数：${key}`);
  }
  const version = text(settings, "vhttp");
  if (version && version.toLowerCase() !== "auto") throw new Error("Xray MASQUE 暂不支持指定 HTTP 版本");
  const privateKey = required(settings, "MASQUE 私钥", "private-key", "private_key", "privateKey");
  const publicKey = required(settings, "MASQUE 服务端公钥", "public-key", "public_key", "publicKey");
  const address = [...list(settings.ip), ...list(settings.ipv6)];
  if (!address.length) throw new Error("MASQUE 至少需要一个客户端 IP");
  const remoteDNS = list(settings.remoteDNS ?? settings.remote_dns);
  const host = text(settings, "host");
  const path = text(settings, "path");
  return {
    protocol: "masque", tag: "proxy",
    settings: { address: node.server, port: node.port, ...(remoteDNS.length ? { remoteDNS } : {}) },
    streamSettings: {
      network: "masque", security: "tls",
      tlsSettings: buildTls(settings, "www.cloudflare.com", false),
      masqueSettings: { ...(host ? { host } : {}), ...(path ? { path } : {}), warp: { privateKey, publicKey, address } },
    },
  };
}

/** 为 sing-box 无法测试的功能生成 Xray 出站配置。 */
export function buildXrayTestOutbound(node: ProxyNode): { outbound?: JsonObject; error?: string } {
  const settings: JsonObject = { ...node.extensions, ...node.settings };
  try {
    if (node.protocol === "masque") return { outbound: masqueOutbound(node, settings) };
    const address = node.server;
    const port = node.port;
    let outbound: JsonObject;
    if (node.protocol === "vless" || node.protocol === "vmess") {
      const id = required(settings, `${node.protocol.toUpperCase()} UUID`, "uuid");
      const encryption = text(settings, "encryption");
      if (node.protocol === "vmess" && encryption && encryption.toLowerCase() !== "none") throw new Error("VMess 不支持 VLESS encryption 参数");
      const user = node.protocol === "vless"
        ? { id, encryption: encryption ?? "none", ...(text(settings, "flow") ? { flow: text(settings, "flow") } : {}) }
        : { id, alterId: Number(settings.alterId ?? settings.alter_id ?? 0), security: text(settings, "cipher") ?? "auto" };
      outbound = { protocol: node.protocol, tag: "proxy", settings: { vnext: [{ address, port, users: [user] }] } };
    } else if (node.protocol === "trojan") {
      const encryption = text(settings, "encryption");
      if (encryption && encryption.toLowerCase() !== "none") throw new Error("Trojan 不支持 VLESS encryption 参数");
      const password = required(settings, "Trojan 密码", "password");
      outbound = { protocol: "trojan", tag: "proxy", settings: { servers: [{ address, port, password }] } };
    } else {
      throw new Error(`Xray 测试暂不支持 ${node.protocol} 协议`);
    }
    outbound.streamSettings = streamSettings(node, settings);
    outbound.mux = { enabled: false };
    return { outbound };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
