// 正式主题挂在站点根目录，用路径路由（/node/1）。
// 演示站（--mode demo）可能部署在任意子路径（如 GitHub Pages），改用 hash 路由（#/node/1）。
const hash = import.meta.env.MODE === "demo";
const current = () =>
  hash ? location.hash.replace(/^#/, "") || "/" : location.pathname;
export const routeId = () => {
  const path = current();
  return path === "/"
    ? null
    : Number(/^\/node\/(\d+)\/?$/.exec(path)?.[1] || -1);
};
export const nodeHref = (id: number) => (hash ? "#/node/" : "/node/") + id;
export const homeHref = hash ? "#/" : "/";
export const hashRouting = hash;
