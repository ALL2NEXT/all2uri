import assert from "node:assert/strict";
import test from "node:test";
import { convertSource, convertSources, convertText } from "../src/core/pipeline.ts";
import { buildLossyConversionLog } from "../src/core/lossy-conversion-log.ts";
import { detectNativeFormat, parseNativeValue } from "../src/core/parsers/native-parser.ts";
import { assessNodeTestReadiness } from "../src/node-test.ts";

const uuid = "11111111-1111-1111-1111-111111111111";

test("direct URI conversion records an origin and emits complete results", () => {
  const result = convertText(`vless://${uuid}@edge.example:443?security=tls#edge`, "source-a");
  assert.equal(result.stats.complete, 1);
  assert.equal(result.uris.length, 1);
  assert.equal(result.nodes[0].sources[0].sourceId, "source-a");
  assert.equal(result.nodes[0].sources[0].location, "fragment[0]/uri[0]");
});

test("positions distinguish repeated node indexes across fragments", () => {
  const result = convertText(
    `trojan://first@one.example:443#one\ntrojan://second@two.example:443#two`,
    "source-a",
  );
  assert.deepEqual(result.nodes.map(node => node.sources[0].location), [
    "fragment[0]/uri[0]",
    "fragment[1]/uri[0]",
  ]);
});

test("unrecognized URI parameters are retained, reported as lossy, and emitted by default", () => {
  const input = `vless://${uuid}@edge.example:443?security=tls&vendorOption=one#edge`;
  const result = convertText(input, "source-a");
  assert.equal(result.stats.lossy, 1);
  assert.equal(result.uris.length, 1);
  assert.equal(result.nodes.length, 1);
  assert.equal(result.encoded[0].status, "lossy");
  assert.equal(result.nodes[0].extensions.vendorOption, "one");
  assert.ok(result.diagnostics.some(item => item.code === "field_not_encoded" && item.field === "vendorOption"));
});

test("lossy conversion log includes omitted config with credentials redacted", () => {
  const result = convertText(
    `vless://${uuid}@edge.example:443?security=tls&vendorOption=one&password=password-secret&token=token-secret#edge`,
    "source-a",
  );
  const node = result.nodes[0];
  const reportNode = {
    ...node,
    extensions: {
      ...node.extensions,
      nested: {
        Authorization: "auth-secret",
        rawConfig: "private raw input",
        sourceUri: "https://user:secret@example.org/subscription",
        visibleOption: "kept",
      },
    },
  };
  const encoded = result.encoded.find((item) => item.node.id === node.id);
  const logEntry = {
    id: `${node.id}-0`,
    name: node.name,
    server: node.server,
    port: node.port,
    protocol: node.protocol,
    uri: result.uris[0],
    conversionStatus: encoded.status,
    conversionDiagnostics: encoded.diagnostics,
    node: reportNode,
  };
  const report = buildLossyConversionLog(
    [logEntry, { ...logEntry, id: "complete-node", conversionStatus: "complete" }],
    { scope: "filtered", generatedAt: "2026-01-01T00:00:00.000Z" },
  );
  const serialized = JSON.stringify(report);
  assert.equal(report.summary.lossyNodeCount, 1);
  assert.deepEqual(report.summary.unencodedFields, ["password", "token", "vendorOption"]);
  assert.equal(report.nodes[0].outputUri, result.uris[0]);
  assert.equal(report.nodes[0].extensions.vendorOption, "one");
  assert.equal(report.nodes[0].extensions.password, "password-secret");
  assert.equal(report.nodes[0].extensions.token, "token-secret");
  assert.equal(report.nodes[0].extensions.nested.Authorization, "auth-secret");
  assert.equal(report.nodes[0].extensions.nested.rawConfig, "private raw input");
  assert.equal(
    report.nodes[0].extensions.nested.sourceUri,
    "https://user:secret@example.org/subscription",
  );
  assert.equal(report.nodes[0].extensions.nested.visibleOption, "kept");
  assert.equal(report.nodes[0].settings.uuid, uuid);
  assert.deepEqual(report.nodes[0].sources, [{
    sourceId: "source-a",
    format: "uri",
    location: "fragment[0]/uri[0]",
  }]);
  assert.equal("raw" in report.nodes[0], false);
  assert.equal("uri" in report.nodes[0], false);
  assert.equal(serialized.includes(uuid), true);
  assert.equal(serialized.includes("password-secret"), true);
  assert.equal(serialized.includes("token-secret"), true);
  assert.equal(serialized.includes("auth-secret"), true);
  assert.equal(serialized.includes("private raw input"), true);
  assert.equal(serialized.includes("user:secret@example.org"), true);
});

test("unknown query values cannot override protocol credentials during encoding", () => {
  const result = convertText(`trojan://original-secret@edge.example:443?password=other-secret#edge`, "source-a");
  assert.equal(result.encoded[0].status, "lossy");
  assert.equal(new URL(result.uris[0]).username, "original-secret");
  assert.ok(result.diagnostics.some(item => item.code === "field_not_encoded" && item.field === "password"));
});

test("VLESS TCP header type and REALITY spiderX survive URI round-trip", () => {
  const input = `vless://${uuid}@edge.example:443?encryption=none&flow=xtls-rprx-vision&security=reality&sni=www.amazon.com&fp=chrome&pbk=test-public-key&sid=test-short-id&spx=%2F&type=tcp&headerType=none#edge`;
  const result = convertText(input, "source-a");
  assert.equal(result.encoded[0].status, "complete");
  const output = new URL(result.uris[0]);
  assert.equal(output.searchParams.get("headerType"), "none");
  assert.equal(output.searchParams.get("spx"), "/");
});

test("TLS, ECH and certificate pin fields survive URI parse and encode", () => {
  const input = `vless://${uuid}@edge.example:443?security=tls&echEnabled=true&echConfigList=abc&echQueryServerName=ech.example&pinSHA256=pin-value&minVersion=1.2&maxVersion=1.3#edge`;
  const result = convertText(input, "source-a");
  assert.equal(result.encoded[0].status, "complete");
  const output = new URL(result.uris[0]);
  assert.equal(output.searchParams.get("echEnabled"), "true");
  assert.equal(output.searchParams.get("echConfigList"), "abc");
  assert.equal(output.searchParams.get("echQueryServerName"), "ech.example");
  assert.equal(output.searchParams.get("pinSHA256"), "pin-value");
  assert.equal(output.searchParams.get("minVersion"), "1.2");
  assert.equal(output.searchParams.get("maxVersion"), "1.3");
});

test("transport options unsupported by a protocol are reported as lossy", () => {
  const result = convertText(`socks5://user:pass@edge.example:1080?type=ws&path=%2Fsocket#edge`, "source-a");
  assert.equal(result.uris.length, 1);
  assert.equal(result.encoded[0].status, "lossy");
  assert.ok(result.diagnostics.some(item => item.code === "field_not_encoded" && item.field === "network"));
  assert.ok(result.diagnostics.some(item => item.code === "field_not_encoded" && item.field === "ws-opts"));
});

test("semantic deduplication ignores names and retains every source", () => {
  const result = convertSources([
    { sourceId: "first", content: `vless://${uuid}@edge.example:443?security=tls#one` },
    { sourceId: "second", content: `vless://${uuid}@edge.example:443?security=tls#two` },
  ]);
  assert.equal(result.stats.duplicates, 1);
  assert.equal(result.nodes.length, 1);
  assert.deepEqual(result.nodes[0].sources.map(source => source.sourceId), ["first", "second"]);
});

test("different unknown connection parameters are not merged", () => {
  const result = convertSources([
    { sourceId: "first", content: `vless://${uuid}@edge.example:443?vendorOption=one#same`, format: "uri" },
    { sourceId: "second", content: `vless://${uuid}@edge.example:443?vendorOption=two#same`, format: "uri" },
  ]);
  assert.equal(result.stats.duplicates, 0);
  assert.equal(result.uris.length, 2);
});

test("nested extension fields named name remain part of the semantic fingerprint", () => {
  const result = convertSources([
    { sourceId: "first", content: JSON.stringify({ proxies: [{ type: "trojan", server: "edge.example", port: 443, password: "secret", vendor: { name: "alpha" } }] }) },
    { sourceId: "second", content: JSON.stringify({ proxies: [{ type: "trojan", server: "edge.example", port: 443, password: "secret", vendor: { name: "beta" } }] }) },
  ]);
  assert.equal(result.stats.duplicates, 0);
  assert.equal(result.uris.length, 2);
});

test("TUIC nodes require both UUID and password", () => {
  const result = convertText(`tuic://${uuid}@edge.example:443#tuic`, "source-a");
  assert.equal(result.stats.invalid, 1);
  assert.equal(result.nodes.length, 1);
  assert.equal(result.nodes[0].protocol, "tuic");
  assert.equal(result.encoded[0].status, "invalid");
  assert.equal(result.uris.length, 0);
  assert.ok(result.diagnostics.some(item => item.code === "missing_credentials" && item.field === "password"));
});

test("node tests distinguish missing test prerequisites from network failures", () => {
  const node = convertText(`tuic://${uuid}@edge.example:443#tuic`, "source-a").nodes[0];
  assert.equal(assessNodeTestReadiness("tcping", node).available, true);
  assert.equal(assessNodeTestReadiness("entry", { ...node, port: 0 }).available, true);
  const proxyTest = assessNodeTestReadiness("url204", node);
  assert.equal(proxyTest.available, false);
  assert.match(proxyTest.reason, /TUIC|password/i);
  assert.equal(
    assessNodeTestReadiness("tcping", { ...node, server: "invalid host" }).available,
    false,
  );

  const masque = convertText(
    `masque://client-private-key@edge.example:443?profile=cloudflare&public_key=server-public-key&ip=10.0.0.2#masque`,
    "source-a",
  ).nodes[0];
  const unsupportedProxyTest = assessNodeTestReadiness("url204", masque);
  assert.equal(unsupportedProxyTest.available, false);
  assert.match(unsupportedProxyTest.reason, /MASQUE/);
});

test("node limits cap accumulated model nodes and report truncation", () => {
  const content = `proxies:\n  - type: trojan\n    name: a\n    server: a.example\n    port: 443\n    password: a\n  - type: trojan\n    name: b\n    server: b.example\n    port: 443\n    password: b`;
  const result = convertSource({ sourceId: "source-a", content }, { limits: { maxNodes: 1 } });
  assert.equal(result.stats.parsedNodes, 1);
  assert.equal(result.uris.length, 1);
  assert.ok(result.diagnostics.some(item => item.code === "node_limit"));
});

test("native parser applies the node cap before materializing all models", () => {
  const value = {
    proxies: [
      { type: "trojan", name: "a", server: "a.example", port: 443, password: "a" },
      { type: "trojan", name: "b", server: "b.example", port: 443, password: "b" },
    ],
  };
  const result = convertSource({ sourceId: "source-a", content: JSON.stringify(value) }, { limits: { maxNodes: 1 } });
  assert.equal(result.stats.parsedNodes, 1);
  assert.equal(result.uris.length, 1);
  assert.ok(result.diagnostics.some(item => item.code === "node_limit"));
});

test("unsupported native candidates do not consume the valid node budget", () => {
  const value = {
    outbounds: [
      { type: "selector", server: "ignored.example", server_port: 443 },
      { type: "block", server: "ignored.example", server_port: 443 },
      { type: "urltest", server: "ignored.example", server_port: 443 },
      { type: "trojan", server: "valid.example", server_port: 443, password: "secret" },
    ],
  };
  const result = convertSource({ sourceId: "source-a", content: JSON.stringify(value) }, { limits: { maxNodes: 1 } });
  assert.equal(result.stats.parsedNodes, 1);
  assert.match(result.uris[0], /valid\.example/);
});

test("Xray outbounds are not labelled as sing-box", () => {
  const value = {
    outbounds: [{ protocol: "vless", settings: { vnext: [] } }],
  };
  assert.equal(detectNativeFormat(value), "xray-json");
});

test("sing-box parser builds a ProxyNode directly and retains native fields", () => {
  const outbound = {
    type: "vless",
    tag: "native-vless",
    server: "sing.example",
    server_port: 443,
    uuid,
    tls: { enabled: true, server_name: "sni.example" },
    transport: { type: "ws", path: "/socket", headers: { Host: "host.example" } },
    vendor_option: { mode: "custom", values: [1, 2, 3] },
  };
  const parsed = parseNativeValue({ outbounds: [outbound] }, { sourceId: "native", format: "auto" });
  assert.equal(parsed.nodes.length, 1);
  assert.equal(parsed.nodes[0].protocol, "vless");
  assert.equal(parsed.nodes[0].sources[0].format, "sing-box-json");
  assert.equal(parsed.nodes[0].sources[0].location, "outbounds[0]");
  assert.equal(parsed.nodes[0].settings.servername, "sni.example");
  assert.deepEqual(parsed.nodes[0].settings["ws-opts"], { path: "/socket", headers: { Host: "host.example" } });
  assert.deepEqual(parsed.nodes[0].settings.vendor_option, outbound.vendor_option);
  assert.equal(parsed.nodes[0].raw, outbound);
});

test("Xray and sing-box YAML configurations enter the native parser registry", () => {
  const xray = convertText(`outbounds:
  - protocol: vless
    tag: xray-yaml
    settings:
      vnext:
        - address: xray.example
          port: 443
          users:
            - id: ${uuid}
              encryption: none`, "xray-yaml");
  assert.equal(xray.uris.length, 1);
  assert.equal(xray.nodes[0].sources[0].format, "xray-yaml");

  const singBox = convertText(`outbounds:
  - type: vless
    tag: sing-box-yaml
    server: sing.example
    server_port: 443
    uuid: ${uuid}`, "sing-box-yaml");
  assert.equal(singBox.uris.length, 1);
  assert.equal(singBox.nodes[0].sources[0].format, "sing-box-yaml");
});

test("Xray native fields outside URI support remain attached and make output lossy", () => {
  const outbound = {
    protocol: "vless",
    tag: "native-xray",
    settings: {
      vnext: [{
        address: "xray.example",
        port: 443,
        users: [{ id: uuid, encryption: "none", flow: "xtls-rprx-vision", level: 0 }],
      }],
      vendor_settings: { feature: true },
    },
    streamSettings: {
      network: "tcp",
      security: "tls",
      tlsSettings: { serverName: "sni.example", vendorTlsMode: "strict" },
    },
    mux: { enabled: true },
  };
  const parsed = parseNativeValue({ outbounds: [outbound] }, { sourceId: "xray", format: "auto" });
  assert.equal(parsed.nodes.length, 1);
  assert.equal(parsed.nodes[0].sources[0].format, "xray-json");
  assert.equal(parsed.nodes[0].settings.uuid, uuid);
  assert.equal(parsed.nodes[0].settings.flow, "xtls-rprx-vision");
  assert.deepEqual(parsed.nodes[0].extensions["settings.vendor_settings"], outbound.settings.vendor_settings);
  assert.deepEqual(parsed.nodes[0].extensions["xray.mux"], outbound.mux);
  assert.equal(parsed.nodes[0].extensions["stream.tls.vendorTlsMode"], "strict");

  const conversion = convertSource({ sourceId: "xray", content: JSON.stringify({ outbounds: [outbound] }) });
  assert.equal(conversion.encoded[0].status, "lossy");
  assert.ok(conversion.diagnostics.some(item => item.code === "field_not_encoded" && item.field === "xray.mux"));
});

test("sing-box WireGuard peer settings and loss diagnostics stay peer-specific", () => {
  const value = {
    endpoints: [{
      type: "wireguard",
      tag: "wg",
      address: ["10.0.0.1/32"],
      private_key: "private",
      peers: [
        { address: "one.example", port: 51820, public_key: "peer-one", allowed_ips: ["0.0.0.0/0"], persistent_keepalive_interval: 15 },
        { address: "two.example", port: 51821, public_key: "peer-two", allowed_ips: ["10.0.0.0/8"], persistent_keepalive_interval: 30 },
      ],
    }],
  };
  const parsed = parseNativeValue(value, { sourceId: "wireguard", format: "auto" });
  assert.equal(parsed.nodes.length, 2);
  assert.deepEqual(parsed.nodes.map(node => [node.server, node.port, node.settings["persistent_keepalive_interval"]]), [
    ["one.example", 51820, 15],
    ["two.example", 51821, 30],
  ]);
  assert.deepEqual(parsed.nodes[0].extensions["peers[0].allowed_ips"], ["0.0.0.0/0"]);
  assert.equal(parsed.nodes[0].extensions["peers[1].allowed_ips"], undefined);
  assert.deepEqual(parsed.nodes[1].extensions["peers[1].allowed_ips"], ["10.0.0.0/8"]);
  assert.equal(parsed.nodes[1].extensions["peers[0].allowed_ips"], undefined);
});

test("one invalid source does not stop another source from converting", () => {
  const result = convertSources([
    { sourceId: "bad", content: "{broken" },
    { sourceId: "good", content: `trojan://secret@edge.example:443#ok` },
  ]);
  assert.equal(result.sourceStats.length, 2);
  assert.equal(result.sourceStats[0].errors, 1);
  assert.equal(result.sourceStats[1].outputNodes, 1);
  assert.equal(result.uris.length, 1);
});

test("cyclic YAML aliases are preserved as lossy data without crashing deduplication", () => {
  const content = `proxies:
  - &proxy
    type: trojan
    name: cyclic
    server: edge.example
    port: 443
    password: secret
    vendor: *proxy`;
  const result = convertText(content, "cyclic");
  assert.equal(result.uris.length, 1);
  assert.equal(result.encoded[0].status, "lossy");
  const report = buildLossyConversionLog(
    result.nodes.map((node, index) => ({
      id: `${node.id}-${index}`,
      name: node.name,
      server: node.server,
      port: node.port,
      protocol: node.protocol,
      uri: result.uris[index] ?? null,
      conversionStatus: result.encoded[index].status,
      conversionDiagnostics: result.encoded[index].diagnostics,
      node,
    })),
    { scope: "all" },
  );
  assert.doesNotThrow(() => JSON.stringify(report));
});
