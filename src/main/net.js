'use strict';
// 取局域网 IP + 组装手机访问 URL。移植 serve.py 的 lan_ip()，但跨平台用 os.networkInterfaces()。
// 只用 IP 那条，不做 .local/mDNS（原型实测本机 mDNS 被网络拦、解析不了，且跨平台不稳）。
const os = require('os');

// 私网段优先级：192.168 / 10 / 172.16-31 视为「真·局域网」，最可能被手机访问到。
function privateRank(ip) {
  if (ip.startsWith('192.168.')) return 0;
  if (ip.startsWith('10.')) return 1;
  if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(ip)) return 2;
  return 3; // 其它公网/未知段排最后
}

function lanIP() {
  const nets = os.networkInterfaces();
  const candidates = [];
  for (const name of Object.keys(nets)) {
    for (const ni of nets[name] || []) {
      // Node 18+ family 可能是数字 4 或字符串 'IPv4'，两种都认
      const isV4 = ni.family === 'IPv4' || ni.family === 4;
      if (!isV4 || ni.internal) continue;
      if (ni.address.startsWith('169.254.')) continue; // APIPA 自分配，连不通
      candidates.push(ni.address);
    }
  }
  if (!candidates.length) return '127.0.0.1';
  candidates.sort((a, b) => privateRank(a) - privateRank(b));
  return candidates[0];
}

function phoneURL(ip, port, token) {
  return 'http://' + ip + ':' + port + '/?t=' + encodeURIComponent(token);
}

module.exports = { lanIP, phoneURL };
