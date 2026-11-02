'use strict';
/**
 * 极简 WebSocket 客户端 / 帧工具（RFC 6455）—— 零第三方依赖。
 * ============================================================================
 * fnOS（飞牛私有云）的全部业务接口都走 WebSocket，而本项目的运行环境
 * （Electron 33 / Node 20 主进程）没有内置的 WebSocket 实现，
 * 因此这里用原生 `http`/`https` + `crypto` 手写一个**够用**的客户端：
 *
 *   - 基于 HTTP Upgrade 完成握手（校验 Sec-WebSocket-Accept）
 *   - 客户端帧必须掩码；服务端帧不带掩码
 *   - 支持 text / binary / continuation 分片重组 / ping / pong / close
 *   - ws:// 与 wss://（自签名证书可放行）
 *
 * 只实现客户端方向需要的子集，不做扩展（permessage-deflate 等）。
 * mock 服务端可复用 encodeFrame(opcode, payload, false) 与 FrameParser。
 * ========================================================================*/
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { URL } = require('url');
const { EventEmitter } = require('events');
const { netError } = require('./http');

/** RFC 6455 规定的握手 GUID */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** 帧操作码 */
const OP = {
  CONT: 0x0,
  TEXT: 0x1,
  BIN: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
};

/** 由 Sec-WebSocket-Key 计算期望的 Sec-WebSocket-Accept */
function acceptKey(key) {
  return crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
}

/**
 * 编码一个 WebSocket 帧。
 * @param {number} opcode         帧操作码
 * @param {Buffer|string} payload 载荷
 * @param {boolean} masked        是否掩码（客户端=true，服务端=false）
 * @param {boolean} fin           是否终止帧（默认 true）
 */
function encodeFrame(opcode, payload, masked = true, fin = true) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload == null ? '' : payload), 'utf8');
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = (fin ? 0x80 : 0x00) | (opcode & 0x0f);
  if (masked) header[1] |= 0x80;
  if (!masked) return Buffer.concat([header, data]);

  const mask = crypto.randomBytes(4);
  const out = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) out[i] = data[i] ^ mask[i & 3];
  return Buffer.concat([header, mask, out]);
}

/**
 * 增量帧解析器：把 TCP 字节流切成一个个完整帧。
 * 用法：const p = new FrameParser((frame) => {…}); p.push(chunk);
 */
class FrameParser {
  constructor(onFrame) {
    this.buf = Buffer.alloc(0);
    this.onFrame = onFrame;
    this.maxLen = 16 * 1024 * 1024; // 单帧上限，防御性
  }

  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      const f = this._read();
      if (!f) break;
      this.onFrame(f);
    }
  }

  _read() {
    const b = this.buf;
    if (b.length < 2) return null;
    const fin = (b[0] & 0x80) !== 0;
    const opcode = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let off = 2;

    if (len === 126) {
      if (b.length < off + 2) return null;
      len = b.readUInt16BE(off);
      off += 2;
    } else if (len === 127) {
      if (b.length < off + 8) return null;
      const big = b.readBigUInt64BE(off);
      off += 8;
      if (big > BigInt(this.maxLen)) throw new Error('WebSocket 帧超出大小上限');
      len = Number(big);
    }
    if (len > this.maxLen) throw new Error('WebSocket 帧超出大小上限');

    let mask = null;
    if (masked) {
      if (b.length < off + 4) return null;
      mask = b.subarray(off, off + 4);
      off += 4;
    }
    if (b.length < off + len) return null;

    const payload = Buffer.from(b.subarray(off, off + len));
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];

    this.buf = b.subarray(off + len);
    return { fin, opcode, payload };
  }
}

/**
 * 建立 WebSocket 连接。
 * @param {string} rawUrl   ws://host:5666/websocket?type=main
 * @param {object} opts     { allowSelfSigned=true, timeout=12000, headers }
 * @returns {Promise<WsConn>}
 */
function connect(rawUrl, opts) {
  const o = opts || {};
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(rawUrl);
    } catch (_) {
      reject(new Error('无效的 WebSocket 地址: ' + rawUrl));
      return;
    }
    if (u.protocol !== 'ws:' && u.protocol !== 'wss:') {
      reject(new Error('WebSocket 地址必须以 ws:// 或 wss:// 开头'));
      return;
    }
    const secure = u.protocol === 'wss:';
    const lib = secure ? https : http;
    const key = crypto.randomBytes(16).toString('base64');
    const port = u.port || (secure ? 443 : 80);

    let settled = false;
    const headers = Object.assign({
      Connection: 'Upgrade',
      Upgrade: 'websocket',
      'Sec-WebSocket-Key': key,
      'Sec-WebSocket-Version': '13',
      Host: u.host,
    }, o.headers || {});

    const req = lib.request({
      hostname: u.hostname,
      port,
      path: (u.pathname || '/') + (u.search || ''),
      method: 'GET',
      headers,
      // allowSelfSigned 默认 true → 不校验证书
      rejectUnauthorized: o.allowSelfSigned === false,
    });

    req.on('upgrade', (res, socket, head) => {
      const expect = acceptKey(key);
      const got = res.headers['sec-websocket-accept'];
      if (got !== expect) {
        socket.destroy();
        if (!settled) { settled = true; reject(new Error('WebSocket 握手校验失败（Accept 不匹配）')); }
        return;
      }
      if (settled) return;
      settled = true;
      resolve(makeConn(socket, head));
    });

    req.on('response', (res) => {
      if (settled) return;
      settled = true;
      const code = res.statusCode;
      res.resume();
      if (code === 401 || code === 403) {
        reject(new Error('WebSocket 握手被拒绝（HTTP ' + code + '），请确认地址端口与服务状态'));
      } else if (code === 301 || code === 302 || code === 308) {
        const loc = res.headers.location || '';
        reject(new Error('WebSocket 被重定向' + (loc ? ' 到 ' + loc : '') + '，若为 HTTPS 站点请改用 wss://'));
      } else {
        reject(new Error('WebSocket 握手失败：HTTP ' + code));
      }
    });

    req.on('error', (e) => {
      if (settled) return;
      settled = true;
      reject(new Error(netError(e, rawUrl)));
    });

    if (o.timeout) {
      req.setTimeout(o.timeout, () => {
        if (!settled) { settled = true; reject(new Error('WebSocket 连接超时')); }
        req.destroy();
      });
    }
    req.end();
  });
}

/** 把已升级的 socket 包装成对上层友好的连接对象 */
function makeConn(socket, head) {
  const emitter = new EventEmitter();
  let closed = false;

  const conn = {
    get closed() { return closed; },
    on: emitter.on.bind(emitter),
    once: emitter.once.bind(emitter),
    off: emitter.off.bind(emitter),
    removeAllListeners: emitter.removeAllListeners.bind(emitter),

    /** 发送一条文本消息 */
    send(text) {
      if (closed) return false;
      socket.write(encodeFrame(OP.TEXT, text, true));
      return true;
    },
    /** 发送一个 WebSocket 层 ping 帧 */
    ping(payload) {
      if (closed) return false;
      socket.write(encodeFrame(OP.PING, payload || '', true));
      return true;
    },
    /** 主动关闭（先发 close 帧） */
    close(code, reason) {
      if (closed) return;
      closed = true;
      try {
        let body = Buffer.alloc(0);
        if (code) {
          body = Buffer.alloc(2);
          body.writeUInt16BE(code, 0);
          if (reason) body = Buffer.concat([body, Buffer.from(String(reason), 'utf8')]);
        }
        socket.write(encodeFrame(OP.CLOSE, body, true));
      } catch (_) { /* ignore */ }
      try { socket.end(); } catch (_) { /* ignore */ }
      try { socket.destroy(); } catch (_) { /* ignore */ }
    },
  };

  // 分片重组状态
  let fragOpcode = 0;
  let fragParts = [];

  const parser = new FrameParser((f) => {
    if (f.opcode === OP.PING) {
      try { socket.write(encodeFrame(OP.PONG, f.payload, true)); } catch (_) { /* ignore */ }
      return;
    }
    if (f.opcode === OP.PONG) return;
    if (f.opcode === OP.CLOSE) {
      try { socket.write(encodeFrame(OP.CLOSE, f.payload, true)); } catch (_) { /* ignore */ }
      try { socket.end(); } catch (_) { /* ignore */ }
      return;
    }
    if (f.opcode === OP.CONT) {
      fragParts.push(f.payload);
      if (f.fin) {
        const data = Buffer.concat(fragParts);
        const binary = fragOpcode === OP.BIN;
        fragParts = [];
        fragOpcode = 0;
        emitter.emit('message', data.toString('utf8'), binary);
      }
      return;
    }
    // text / binary（首帧）
    if (f.opcode === OP.TEXT || f.opcode === OP.BIN) {
      if (!f.fin) {
        fragOpcode = f.opcode;
        fragParts = [f.payload];
        return;
      }
      emitter.emit('message', f.payload.toString('utf8'), f.opcode === OP.BIN);
      return;
    }
    // 未知操作码：忽略
  });

  socket.on('data', (chunk) => {
    try {
      parser.push(chunk);
    } catch (e) {
      emitter.emit('error', e instanceof Error ? e : new Error(String(e)));
      conn.close();
    }
  });

  const finish = () => {
    if (closed) return;
    closed = true;
    emitter.emit('close');
  };
  socket.on('close', finish);
  socket.on('end', finish);
  socket.on('error', (e) => {
    emitter.emit('error', new Error(netError(e)));
    finish();
  });

  // 连接建立后不再需要超时（长连接）
  try { socket.setTimeout(0); } catch (_) { /* ignore */ }
  try { socket.setNoDelay(true); } catch (_) { /* ignore */ }

  // 握手响应头之后可能已带上首批数据
  if (head && head.length) {
    try { parser.push(head); } catch (_) { /* ignore */ }
  }

  return conn;
}

module.exports = {
  connect,
  FrameParser,
  encodeFrame,
  acceptKey,
  OP,
  WS_GUID,
};
