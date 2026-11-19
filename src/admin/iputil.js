// src/admin/iputil.js - 客户端来源 IP（对应参考 server/iputil.py）
const ipTrust = require('../ip-trust');

module.exports = { clientIP: ipTrust.clientIP };
