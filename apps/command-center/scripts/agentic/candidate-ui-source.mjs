/** Route candidate source into one owned page, preserving its real gateway and login. */
export async function routeCandidateUiSource(page, { origin, source, root }) {
  const proxy = async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/' || url.pathname.startsWith('/api/') || url.pathname === '/ws')
      return route.continue();
    if (url.pathname === '/@vite/client')
      return route.fulfill({
        contentType: 'text/javascript',
        body: 'const styles=new Map();export const createHotContext=()=>({on(){},accept(){},prune(){},dispose(){},data:{}});export const injectQuery=(url)=>url;export function updateStyle(id,css){let s=styles.get(id);if(!s){s=document.createElement("style");document.head.append(s);styles.set(id,s)}s.textContent=css}export function removeStyle(id){styles.get(id)?.remove();styles.delete(id)}',
      });
    const response = await fetch(new URL(url.pathname + url.search, source));
    await route.fulfill({
      status: response.status,
      headers: Object.fromEntries(
        [...response.headers].filter(
          ([key]) => !['content-encoding', 'content-length', 'transfer-encoding'].includes(key),
        ),
      ),
      body: Buffer.from(await response.arrayBuffer()),
    });
  };
  const context = page.context();
  const pagePattern = `${origin}/**`;
  const workerPattern = `${origin}/@fs${root}**`;
  await page.route(pagePattern, proxy);
  await context.route(workerPattern, proxy);
  return async () => {
    await page.unroute(pagePattern, proxy);
    await context.unroute(workerPattern, proxy);
  };
}
