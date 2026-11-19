import type { ProxyProtocol } from "../core/model/proxy-node.ts";

export const OUTPUT_PROTOCOLS: Array<{ value: ProxyProtocol; label: string }> =
  [
    { value: "vless", label: "VLESS" },
    { value: "vmess", label: "VMess" },
    { value: "ss", label: "Shadowsocks" },
    { value: "trojan", label: "Trojan" },
    { value: "hysteria2", label: "Hysteria2" },
    { value: "tuic", label: "TUIC" },
    { value: "anytls", label: "AnyTLS" },
    { value: "socks5", label: "SOCKS5" },
    { value: "socks4", label: "SOCKS4" },
    { value: "socks4a", label: "SOCKS4a" },
    { value: "socks", label: "SOCKS" },
    { value: "wireguard", label: "WireGuard" },
    { value: "naive", label: "NaiveProxy" },
    { value: "masque", label: "MASQUE" },
  ];

export const OUTPUT_COLUMN_DEFAULT_WIDTHS: Record<string, number> = {
  index: 64,
  name: 360,
  protocol: 100,
  conversionStatus: 132,
  server: 190,
  port: 72,
  entryIp: 190,
  entryRegion: 130,
  entryType: 88,
  exitIp: 170,
  exitRegion: 130,
  exitType: 88,
  rtt: 110,
  http: 120,
  average: 140,
  peak: 140,
  perSecond: 120,
  ipRisk: 100,
};

export const OUTPUT_COLUMN_MIN_WIDTH = 36;
export const OUTPUT_TABLE_ROW_HEIGHT_ESTIMATE = 41;
export const OUTPUT_TABLE_VIRTUALIZATION_THRESHOLD = 200;
export const OUTPUT_TABLE_OVERSCAN_ROWS = 8;

export type OutputColumnGroupId =
  | "basic"
  | "link"
  | "performance"
  | "ipQuality"
  | "unlock";

export const OUTPUT_COLUMN_GROUPS: Array<{
  id: OutputColumnGroupId;
  label: string;
}> = [
  { id: "basic", label: "基础信息" },
  { id: "link", label: "链路信息" },
  { id: "performance", label: "性能信息" },
  { id: "ipQuality", label: "IP 质量" },
  { id: "unlock", label: "解锁信息" },
];

export const OUTPUT_COLUMN_GROUP_BY_KEY = new Map<string, OutputColumnGroupId>([
  ...["index", "name", "protocol", "conversionStatus", "server", "port"].map(
    (key) => [key, "basic"] as const,
  ),
  ...[
    "entryIp",
    "entryRegion",
    "entryType",
    "exitIp",
    "exitRegion",
    "exitType",
  ].map((key) => [key, "link"] as const),
  ...["rtt", "http", "average", "peak", "perSecond"].map(
    (key) => [key, "performance"] as const,
  ),
  ["ipRisk", "ipQuality"],
]);
