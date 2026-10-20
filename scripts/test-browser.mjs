import { build } from 'esbuild'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { chromium, expect } from '@playwright/test'

const bundle = await build({ entryPoints: ['tests/fixture.tsx'], bundle: true, write: false, loader: { '.css': 'empty' }, format: 'iife', jsx: 'automatic' })
const css = await readFile('src/threads.css', 'utf8')
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Thread controls test fixture</title><style>${css}
body{margin:0;background:#202c31;color:#e7eeed;font:14px system-ui}main{max-width:390px;margin:40px auto}article{margin-bottom:26px}.owner{display:flex;align-items:center;gap:14px;padding:12px;background:#293d42;border-radius:5px}.avatar{color:#7776e5;font-size:28px}.avatar.team{color:#bdd34e}.fixture-label{font-size:12px;color:#a3b5b2;margin-bottom:24px}.activity-event{margin:8px 32px;border:1px solid #526260;background:transparent;color:#b8c8c4;padding:6px;font-size:11px;border-radius:4px}</style><div id="root"></div><script src="/fixture.js"></script></html>`
const server = createServer((request, response) => {
  response.setHeader('Content-Type', request.url === '/fixture.js' ? 'text/javascript' : 'text/html')
  response.end(request.url === '/fixture.js' ? bundle.outputFiles[0].contents : html)
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
let browser
try {
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true })
  const page = await browser.newPage({ viewport: { width: 960, height: 850 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  for (const title of ['MeTA Release', 'Release Team']) {
    const section = page.getByRole('region', { name: `${title} threads`, exact: true })
    await section.getByRole('button', { name: 'Rename Monday Release' }).click()
    await page.getByRole('textbox').fill('Deployment')
    await page.getByRole('textbox').press('Enter')
    await expect(section.getByRole('button', { name: 'Deployment', exact: true })).toBeVisible()
    await section.getByRole('button', { name: 'Rename Deployment' }).click()
    await page.getByRole('textbox').fill('Discard me')
    await page.mouse.click(10, 10)
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(section.getByRole('button', { name: 'Deployment', exact: true })).toBeVisible()
    await section.getByRole('button', { name: 'Move Checklist' }).dragTo(section.getByRole('button', { name: 'Release plan', exact: true }))
    await expect(section.locator('.hvt-name')).toHaveText(['Checklist', 'Release plan', 'Deployment'])
    await section.getByRole('combobox').selectOption('activity')
    await expect(section.locator('.hvt-name')).toHaveText(['Deployment', 'Checklist', 'Release plan'])
    await section.getByRole('combobox').selectOption('manual')
    await expect(section.locator('.hvt-name')).toHaveText(['Checklist', 'Release plan', 'Deployment'])
  }
  await page.reload()
  const bot = page.getByRole('region', { name: 'MeTA Release threads', exact: true })
  await expect(bot.locator('.hvt-name')).toHaveText(['Checklist', 'Release plan', 'Deployment'])
  await bot.getByRole('combobox').selectOption('activity')
  await page.getByRole('button', { name: 'Simulate reply in Release plan' }).first().click()
  await expect(bot.locator('.hvt-name')).toHaveText(['Release plan', 'Deployment', 'Checklist'])
  await bot.getByRole('button', { name: 'Rename Deployment' }).click()
  await page.getByRole('textbox').fill('Deploy')
  await page.getByRole('button', { name: 'Simulate reply in Release plan' }).first().evaluate(button => button.click())
  await page.getByRole('textbox').pressSequentially('ment')
  await page.getByRole('textbox').press('Enter')
  await expect(bot.getByRole('button', { name: 'Deployment', exact: true })).toBeVisible()
  await expect(errors).toEqual([])
  if (process.env.SCREENSHOT_PATH) await page.screenshot({ path: process.env.SCREENSHOT_PATH, fullPage: true })
  console.log('Browser passed: bot/team rename, outside cancellation, real drag and drop, activity sorting, reload persistence, live activity updates; no page errors.')
} finally {
  await browser?.close()
  server.close()
}
