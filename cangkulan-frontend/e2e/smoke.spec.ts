import { test, expect } from '@playwright/test';

// ═══════════════════════════════════════════════════════════════════════════════
//  E2E Smoke Tests — Cangkulan Frontend
//  Verify the app loads, key pages render, and navigation works.
// ═══════════════════════════════════════════════════════════════════════════════

test.describe('Smoke Tests', () => {
  test('homepage loads with hero and navigation', async ({ page }) => {
    await page.goto('/');

    // Hero h1 renders
    await expect(
      page.getByRole('heading', { name: 'Cangkulan Lite', exact: true }),
    ).toBeVisible({ timeout: 15_000 });

    // At least one button or interactive element
    const buttons = page.locator('button, a[role="button"]');
    expect(await buttons.count()).toBeGreaterThan(0);
  });

  test('can navigate to Rules page', async ({ page }) => {
    await page.goto('/#/rules');
    await expect(
      page.getByRole('heading', { name: 'How to Play Cangkulan' }),
    ).toBeVisible({ timeout: 15_000 });
  });

  test('can navigate to Leaderboard page', async ({ page }) => {
    await page.goto('/#/leaderboard');
    await expect(
      page.getByRole('heading', { name: 'Leaderboard', exact: true }),
    ).toBeVisible({ timeout: 15_000 });
  });

  test('can navigate to Architecture page', async ({ page }) => {
    await page.goto('/#/architecture');
    await expect(
      page.getByRole('heading', { name: 'Architecture', exact: true }),
    ).toBeVisible({ timeout: 15_000 });
  });

  test('can navigate to Stats page', async ({ page }) => {
    await page.goto('/#/stats');
    await expect(
      page.getByRole('heading', { name: 'On-Chain Analytics' }),
    ).toBeVisible({ timeout: 15_000 });
  });

  test('can navigate to History page', async ({ page }) => {
    await page.goto('/#/history');
    await expect(
      page.getByRole('heading', { name: 'Game History', exact: true }),
    ).toBeVisible({ timeout: 15_000 });
  });

  test('can navigate to Tutorial page', async ({ page }) => {
    await page.goto('/#/tutorial');
    await expect(
      page.getByRole('heading', { name: 'Tutorial', exact: true }),
    ).toBeVisible({ timeout: 15_000 });
  });

  test('hash navigation works from homepage', async ({ page }) => {
    await page.goto('/');
    await expect(
      page.getByRole('heading', { name: 'Cangkulan Lite', exact: true }),
    ).toBeVisible({ timeout: 15_000 });

    // Navigate via URL hash change
    await page.goto('/#/rules');
    await expect(
      page.getByRole('heading', { name: 'How to Play Cangkulan' }),
    ).toBeVisible({ timeout: 15_000 });

    // Navigate back
    await page.goto('/');
    await expect(
      page.getByRole('heading', { name: 'Cangkulan Lite', exact: true }),
    ).toBeVisible({ timeout: 15_000 });
  });
});

test.describe('Responsive Layout', () => {
  test('mobile viewport renders without horizontal scroll', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/');
    await expect(
      page.getByRole('heading', { name: 'Cangkulan Lite', exact: true }),
    ).toBeVisible({ timeout: 15_000 });

    // Check no horizontal overflow
    const bodyWidth = await page.evaluate(() => document.body.scrollWidth);
    const viewportWidth = await page.evaluate(() => window.innerWidth);
    expect(bodyWidth).toBeLessThanOrEqual(viewportWidth + 5); // 5px tolerance
  });
});

test.describe('Wallet Connection', () => {
  test('game page redirects to wallet connect when not connected', async ({ page }) => {
    await page.goto('/#/game');
    // Should show the homepage since no wallet is connected
    await expect(
      page.getByRole('heading', { name: 'Cangkulan Lite', exact: true }),
    ).toBeVisible({ timeout: 15_000 });
  });
});
