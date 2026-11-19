'use strict';

const net = require('net');

const CLIENT_IP_HEADER = 'x-dumate-client-ip';

function normalizeIP(raw) {
  let value = String(raw || '').trim();
  if (value.startsWith('::ffff:')) value = value.slice(7);
  return net.isIP(value) ? value : '';
}

function isLoopback(raw) {
  const value = normalizeIP(raw);
  return value === '127.0.0.1' || value === '::1';
}

function trustedForwardedIP(req) {
  const peer = req && req.socket && req.socket.remoteAddress;
  if (!isLoopback(peer)) return '';
  const raw = req && req.headers && req.headers[CLIENT_IP_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return normalizeIP(value);
}

function clientIP(req) {
  const peer = req && req.socket && req.socket.remoteAddress;
  return trustedForwardedIP(req) || normalizeIP(peer);
}

module.exports = {
  CLIENT_IP_HEADER,
  normalizeIP,
  isLoopback,
  trustedForwardedIP,
  clientIP,
};
