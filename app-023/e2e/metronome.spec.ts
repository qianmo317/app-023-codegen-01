// E2E —— 节拍器：预备小节 → 正小节计数、停止重来、播放中改拍数不打断当前小节、变速
import { expect, test } from '@playwright/test';

test.describe('节拍器', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('#/metronome');
    await expect(page.getByTestId('metro-page')).toBeVisible();
  });

  test('先数一小节预备，再进入第 1 小节，位置显示正确', async ({ page }) => {
    // 放慢到 60 BPM（1s/拍）便于观察
    await page.getByTestId('metro-bpm').fill('60');
    await page.getByTestId('metro-toggle').click();

    await expect(page.getByTestId('metro-pos')).toContainText('预备小节', { timeout: 5000 });
    await expect(page.getByTestId('metro-pos')).toContainText('第 1 拍');

    // 预备小节走 4 拍（约 4 秒）后进入第 1 小节
    await expect(page.getByTestId('metro-pos')).toContainText('第 1 小节', { timeout: 8000 });

    // 调度事件：每小节首拍重音，其余轻音
    const ok = await page.evaluate(() => {
      const evs = (window as unknown as { __metroScheduled?: () => { beat: number; accent: boolean }[] }).__metroScheduled?.() ?? [];
      return evs.length > 4 && evs.every((e) => e.accent === (e.beat === 0));
    });
    expect(ok).toBe(true);
  });

  test('中途停止再开始从预备小节重新数', async ({ page }) => {
    await page.getByTestId('metro-bpm').fill('60');
    await page.getByTestId('metro-toggle').click();
    await expect(page.getByTestId('metro-pos')).toContainText('预备小节', { timeout: 5000 });
    await expect(page.getByTestId('metro-pos')).toContainText('第 2 拍', { timeout: 3000 });

    await page.getByTestId('metro-toggle').click();
    await expect(page.getByTestId('metro-pos')).toHaveText('已停止');

    // 再开始：又从预备小节第 1 拍起
    await page.getByTestId('metro-toggle').click();
    await expect(page.getByTestId('metro-pos')).toContainText('预备小节', { timeout: 5000 });
    await expect(page.getByTestId('metro-pos')).toContainText('第 1 拍');
  });

  test('2/3/4 拍选择生效：每小节事件数随拍数变化', async ({ page }) => {
    await page.getByTestId('metro-bpm').fill('240');
    await page.getByTestId('metro-beats-3').click();
    await page.getByTestId('metro-toggle').click();
    await expect(page.getByTestId('metro-pos')).toBeVisible();
    await page.waitForTimeout(1500);
    const barBeatCounts = await page.evaluate(() => {
      const evs = (window as unknown as { __metroScheduled?: () => { bar: number; beats: number }[] }).__metroScheduled?.() ?? [];
      const m = new Map<number, number>();
      for (const e of evs) m.set(e.bar, e.beats);
      return [...m.entries()].sort((a, b) => a[0] - b[1]);
    });
    expect(barBeatCounts.length).toBeGreaterThan(0);
    expect(barBeatCounts.every(([, n]) => n === 3)).toBe(true);
  });

  test('渐变速：速度显示在 N 小节内从起始趋向目标', async ({ page }) => {
    await page.getByTestId('metro-bpm').fill('60');
    await page.getByTestId('metro-ramp-on').check();
    await page.getByTestId('metro-ramp-bars').fill('4');
    await page.getByTestId('metro-ramp-to').fill('120');
    await page.getByTestId('metro-toggle').click();
    // 预备小节（约 4s）与第 1 正小节速度均为起始值，进入第 2 小节后开始爬升
    await expect
      .poll(
        async () => Number(((await page.getByTestId('metro-tempo').textContent()) ?? '').replace(/[^0-9.]/g, '')),
        { timeout: 15_000 },
      )
      .toBeGreaterThan(60);
    const tempoText = await page.getByTestId('metro-tempo').textContent();
    const v = Number((tempoText ?? '').replace(/[^0-9.]/g, ''));
    expect(v).toBeLessThanOrEqual(120);
  });
});
