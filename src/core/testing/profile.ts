import type { ProxyNode } from "../model/proxy-node.ts";
import { buildSingBoxTestProfile, type SingBoxTestProfile } from "./sing-box.ts";
import { buildXrayTestOutbound } from "./xray.ts";

export type TestCore = "sing-box" | "xray";
export interface NodeProxyTestProfile extends SingBoxTestProfile { core: TestCore; }

const TLS_EXTENSIONS = [
  "key_share", "key-share", "keyShare", "fragment", "fragment_fallback_delay", "fragment-fallback-delay",
  "fragmentFallbackDelay", "record_fragment", "record-fragment", "recordFragment",
];
const AMNEZIA_PARAMETERS = [
  "jc", "jmin", "jmax", "s1", "s2", "s3", "s4", "h1", "h2", "h3", "h4", "i1", "i2", "i3", "i4", "i5",
  "id", "header_protection_key", "content_padding_addition", "rekey_after_time", "rekey_timeout", "reject_after_time",
  "keepalive_timeout", "max_handshake_attempts", "random_trailers", "disable_cookies", "persistent_keepalive_interval",
];

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** 参考 Android 的默认选核规则：普通节点使用 sing-box，特殊功能使用 Xray。 */
export function buildNodeProxyTestProfile(node: ProxyNode): { profile?: NodeProxyTestProfile; error?: string } {
  const settings = { ...node.extensions, ...node.settings };
  const reality = object(settings["reality-opts"] ?? settings.reality_opts);
  if (["vless", "vmess", "trojan", "hysteria2", "anytls", "tuic", "naive", "masque"].includes(node.protocol)) {
    const unsupported = TLS_EXTENSIONS.find(key => settings[key] !== undefined || reality[key] !== undefined || settings[`tls.${key}`] !== undefined);
    if (unsupported) return { error: `当前核心不支持 TLS 扩展参数：${unsupported}` };
  }
  if (node.protocol === "wireguard") {
    const unsupported = AMNEZIA_PARAMETERS.find(key => settings[key] !== undefined);
    if (unsupported || ["quic", "dns", "stun", "sip"].includes(String(settings.ip ?? "").toLowerCase())) {
      return { error: `当前核心不支持此 WireGuard 扩展${unsupported ? `：${unsupported}` : ""}` };
    }
  }
  const network = String(settings.network ?? settings.transport ?? "").toLowerCase();
  const encryption = String(settings.encryption ?? "").trim().toLowerCase();
  const mlkem = reality["support-x25519mlkem768"] ?? reality.support_x25519mlkem768;
  const mlkemEnabled = mlkem === true || mlkem === 1 || (typeof mlkem === "string" && ["true", "1"].includes(mlkem.toLowerCase()));
  const requiresXray = node.protocol === "masque" || (
    ["vless", "vmess", "trojan"].includes(node.protocol)
    && (["xhttp", "splithttp", "split-http"].includes(network) || (encryption !== "" && encryption !== "none") || mlkemEnabled)
  );
  if (requiresXray) {
    const result = buildXrayTestOutbound(node);
    return result.outbound ? { profile: { core: "xray", outbound: result.outbound } } : { error: result.error };
  }
  const result = buildSingBoxTestProfile(node);
  return result.profile ? { profile: { core: "sing-box", ...result.profile } } : { error: result.error };
}
