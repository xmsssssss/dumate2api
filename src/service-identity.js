// src/service-identity.js - 进程身份（/health 的 role 字段 + X-Service 响应头）
//
// 管理端入口（9080）代理到内部模型网关（18081），两个进程各有自己的 role。
// 端口探活时「返回 2xx 的不一定是本服务」——同端口残留的其他服务、或别的项目
// 占用了端口都会造成假成功（workbuddy2api 面板 2026-11 版的同类设计：强校验用
// 带 Key 的状态端点，弱校验用无鉴权 health + 身份字段）。
//
// 字段口径：
//   service 固定 'dumate2api'（品牌级，各进程相同——探活判它就知道命中了本仓库）
//   role    区分入口：gateway / admin / web-gateway；DUMATE_ROLE 环境变量可覆盖
//   stable  历史遗留：曾用 stable/ 冻结快照跑对外实例，靠目录路径加 '-stable' 后缀
//           区分同源的两个进程。快照机制已退役，正常检出不带该后缀；
//           判定保留是为了兼容旧调用点与测试。DUMATE_ROLE 仍可显式
//           指定任意 role。
const STABLE_DIR = /[\\/]stable[\\/]/.test(__dirname);

/**
 * @param {string} baseRole 入口基础角色（gateway / admin / web-gateway）
 * @returns {{ service: string, role: string }}
 */
function identity(baseRole) {
  const env = String(process.env.DUMATE_ROLE || '').trim();
  const role = env || (STABLE_DIR ? `${baseRole}-stable` : baseRole);
  return { service: 'dumate2api', role };
}

module.exports = { identity, STABLE_DIR };
