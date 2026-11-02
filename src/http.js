'use strict';
/**
 * HTTP 传输层 —— 各 provider 复用的底层请求封装。
 * 支持 GET / POST(PUT/DELETE)，自定义请求头，自签名证书与超时。
 */
const http = require('http');
const https = require('https');
const { URL } = require('url');

/** 把 Node 网络错误翻译成中文提示 */
function netError(e, target) {
  const code = e && e.code;
  if (code === 'ENOTFOUND') return '无法解析主机名，请检查服务器地址';
  if (code === 'ECONNREFUSED') return '连接被拒绝，请确认服务器已启动且 API 已开放';
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT') return '连接超时，请检查网络或防火墙';
  if (code === 'CERT_HAS_EXPIRED' || code === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
      code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || code === 'SELF_SIGNED_CERT_IN_CHAIN') {
    return 'TLS 证书校验失败，请在设置中勾选「允许自签名证书」';
  }
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return '网络不可达';
  return (e && e.message) ? e.message : ('请求失败: ' + String(target));
}

/**
 * 执行一次 HTTP(S) 请求。
 * @param {string} url    完整地址
 * @param {object} opts   { method, headers, body(Buffer|string|null), allowSelfSigned, timeout }
 * @returns {Promise<{status:number, text:string, json:any, headers:object}>}
 */
function request(url, opts) {
  const o = opts || {};
  const allowSelfSigned = o.allowSelfSigned !== false;
  const timeout = o.timeout || 12000;
  const method = (o.method || 'GET').toUpperCase();

  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (_) { reject(new Error('无效的服务器地址: ' + url)); return; }
    const lib = u.protocol === 'https:' ? https : http;

    let payload = null;
    if (o.body != null) {
      payload = Buffer.isBuffer(o.body) ? o.body : Buffer.from(String(o.body), 'utf8');
    }

    const headers = Object.assign({
      'Accept': 'application/json',
      'User-Agent': 'NasAssistant/1.0',
    }, o.headers || {});
    if (payload) {
      if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = payload.length;
    }

    const req = lib.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method,
      headers,
      rejectUnauthorized: !allowSelfSigned,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (_) { /* 非 JSON */ }
        resolve({ status: res.statusCode, text, json, headers: res.headers });
      });
    });
    req.on('error', (e) => reject(new Error(netError(e, url))));
    req.setTimeout(timeout, () => req.destroy(new Error('请求超时 (' + timeout + 'ms)')));
    if (payload) req.write(payload);
    req.end();
  });
}

module.exports = { request, netError };
