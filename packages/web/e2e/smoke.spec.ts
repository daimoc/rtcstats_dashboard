import { test, expect } from '@playwright/test';

test('smoke: login and view sessions', async ({ page }) => {
  await page.goto('http://localhost:5173');

  // Should see login page
  await expect(page.locator('h1')).toContainText('Login');

  // Fill login form
  await page.fill('input[name="password"]', 'correct-password');
  await page.click('button[type="submit"]');

  // Should redirect to session browser
  await expect(page).toHaveURL(/.*sessions/);
});

test('smoke: API health check', async ({ page }) => {
  const resp = await page.goto('http://localhost:5173/api/health');
  expect(resp?.status()).toBe(200);
  const body = await resp?.json();
  expect(body).toEqual({ status: 'ok' });
});

test('smoke: rules endpoint', async ({ page }) => {
  const resp = await page.goto('http://localhost:5173/api/rules');
  expect(resp?.status()).toBe(200);
  const body = await resp?.json();
  expect(Array.isArray(body)).toBe(true);
  expect(body.length).toBe(32);
});
