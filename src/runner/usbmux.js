// usbmuxd client (macOS: /var/run/usbmuxd): a TCP stream to a port on a USB-connected iPhone, what iproxy does.
// Each message: 16-byte header (total length, version 1, type 8 = plist, tag), then an XML plist.
const net = require("node:net");

const SOCKET = "/var/run/usbmuxd";

const plist = (msg) =>
  '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>' +
  Object.entries({ ClientVersionString: "mantis", ProgName: "mantis", kLibUSBMuxVersion: 3, ...msg })
    .map(([k, v]) => `<key>${k}</key>` + (typeof v === "number" ? `<integer>${v}</integer>` : `<string>${v}</string>`))
    .join("") +
  "</dict></plist>";

function send(sock, msg) {
  const body = Buffer.from(plist(msg));
  const head = Buffer.alloc(16);
  head.writeUInt32LE(16 + body.length, 0);
  head.writeUInt32LE(1, 4);
  head.writeUInt32LE(8, 8);
  head.writeUInt32LE(1, 12);
  sock.write(Buffer.concat([head, body]));
}

// One reply. ponytail: nothing follows it before we write (the device side speaks only after our WS handshake),
// so there are no extra bytes to hand back to the stream.
const reply = (sock) =>
  new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length < 16 || buf.length < buf.readUInt32LE(0)) return;
      sock.off("data", onData).off("error", reject).off("close", onClose);
      resolve(buf.subarray(16, buf.readUInt32LE(0)).toString());
    };
    const onClose = () => reject(new Error("usbmuxd closed the connection"));
    sock.on("data", onData).once("error", reject).once("close", onClose);
  });

const open = () =>
  new Promise((resolve, reject) => {
    const sock = net.connect(SOCKET, () => resolve(sock)).once("error", reject);
  });

/**
 * usbmuxd's DeviceID of the iPhone with this hardware UDID, connected over USB (not Wi-Fi sync). A new one after every
 * replug, so look it up for each connection.
 */
async function deviceId(udid) {
  const sock = await open();
  try {
    send(sock, { MessageType: "ListDevices" });
    // each device's Properties is a flat dict (no nested </dict> before its end)
    const props = (await reply(sock)).split("<key>Properties</key>").slice(1).map((s) => s.slice(0, s.indexOf("</dict>")));
    const field = (p, k) => new RegExp(`<key>${k}</key>\\s*<(?:string|integer)>([^<]*)<`).exec(p)?.[1];
    // SerialNumber is the UDID, with or without its dash depending on the device generation
    const want = udid.replace(/-/g, "").toLowerCase();
    const d = props.find(
      (p) => field(p, "ConnectionType") === "USB" && field(p, "SerialNumber")?.replace(/-/g, "").toLowerCase() === want,
    );
    if (!d) throw new Error(`usbmux: no iPhone ${udid} on USB (unplugged, or not the hardware UDID)`);
    return Number(field(d, "DeviceID"));
  } finally {
    sock.destroy();
  }
}

/** A socket connected to `port` on the iPhone (its 127.0.0.1). Rejects while nothing listens there, or it's unplugged. */
async function connect(udid, port) {
  const id = await deviceId(udid);
  const sock = await open();
  // PortNumber in network byte order
  send(sock, { MessageType: "Connect", DeviceID: id, PortNumber: ((port & 0xff) << 8) | (port >> 8) });
  const r = await reply(sock).catch((e) => (sock.destroy(), Promise.reject(e)));
  const result = Number(/<key>Number<\/key>\s*<integer>(\d+)<\/integer>/.exec(r)?.[1]);
  if (result !== 0) {
    sock.destroy();
    // 3 = connection refused (the app isn't running / not listening yet)
    throw Object.assign(new Error(`usbmux: connect to device port ${port} failed (${result})`), { result });
  }
  return sock;
}

module.exports = { connect, deviceId };
