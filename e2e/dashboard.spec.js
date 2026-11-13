// The public dashboard: every recorded tender renders, switching tabs never mixes tenders, and the in-browser chain
// check either matches Kite or says it couldn't reach it, but never shows another tender's proof.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const index = JSON.parse(readFileSync('public/tenders.json', 'utf8'));
const shown = (page) => page.evaluate(() => window.__lastRfq?.id);
const proofDone = (page) => expect(page.locator('#proof')).not.toContainText('Checking', { timeout: 45_000 });
const winnerOf = (id) => JSON.parse(readFileSync(`public/tenders/${id}.json`, 'utf8')).award.winner;

test('opens on the featured tender with a tab per recorded tender', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#tenders button')).toHaveCount(index.length);
  await expect.poll(() => shown(page)).toBe(index.find((t) => t.featured).id);
  await expect(page.locator('#tenders button[aria-pressed="true"]')).toHaveCount(1);
});

for (const t of index) {
  test(`tender ${t.label}: renders, OCDS link works, chain check never mismatches`, async ({ page, request }) => {
    await page.goto('/');
    await page.locator(`#tenders button[data-id="${t.id}"]`).click();
    await expect.poll(() => shown(page)).toBe(t.id);
    await expect(page.locator(`#tenders button[data-id="${t.id}"]`)).toHaveAttribute('aria-pressed', 'true');
    expect((await request.get(await page.locator('#ocds').getAttribute('href'))).ok()).toBe(true);
    await proofDone(page);
    const proof = await page.locator('#proof').innerText();
    expect(proof).not.toContain('MISMATCH');
    if (proof.startsWith('✓')) expect(proof).toContain(`pays ${winnerOf(t.id)}`);
    else expect(proof).toContain("Couldn't reach Kite testnet"); // RPC down: said plainly, never a false ✓
  });
}

test('rapid tab switching: the last click wins and its proof is the one shown', async ({ page }) => {
  test.skip(index.length < 2, 'needs two tenders');
  const [a, b] = index;
  await page.goto('/');
  await expect(page.locator('#tenders button')).toHaveCount(index.length);
  for (let i = 0; i < 3; i++) {
    await page.locator(`#tenders button[data-id="${a.id}"]`).click();
    await page.locator(`#tenders button[data-id="${b.id}"]`).click();
  }
  await expect.poll(() => shown(page)).toBe(b.id);
  await proofDone(page);
  await page.waitForTimeout(3000); // give a stale check for the other tender time to (wrongly) land
  expect(await shown(page)).toBe(b.id);
  const proof = await page.locator('#proof').innerText();
  if (proof.startsWith('✓') && winnerOf(a.id) !== winnerOf(b.id)) expect(proof).not.toContain(`pays ${winnerOf(a.id)}`);
});

test('no horizontal scroll', async ({ page }) => {
  await page.goto('/');
  await expect.poll(() => shown(page)).toBeTruthy();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});

// --- slash proof pages ----------------------------------------------------------------------------------------
const slashes = index.flatMap((t) => Object.values(JSON.parse(readFileSync(`public/tenders/${t.id}.json`, 'utf8')).bids)
  .filter((b) => b.slash && b.evidence).map((b) => ({ id: t.id, label: b.label })));
const verdict = async (page) => {
  await expect(page.locator('#result')).toContainText(/match Kite|does not match|Couldn't reach/, { timeout: 45_000 });
  return page.locator('#result').innerText();
};

for (const s of slashes) {
  test(`proof page ${s.id} ${s.label}: quote highlighted, hashes match Kite`, async ({ page }) => {
    await page.goto(`/slash.html?t=${s.id}&b=${encodeURIComponent(s.label)}`);
    await expect(page.locator('mark')).toHaveCount(1);
    const v = await verdict(page);
    test.skip(v.includes("Couldn't reach"), 'Kite RPC unreachable');
    expect(v).toContain('✓ The slash and its evidence match Kite testnet');
    expect(v).not.toContain('MISMATCH');
  });
}

// The page must catch a doctored publication, not just display a tick.
for (const [what, mutate] of [
  // change one letter of the quote, in the quote and in the document, so the quote is still "in the document"
  ['quote', (b) => { const e2 = b.evidence.replace(/[A-Za-z]/, (c) => (c === 'x' ? 'y' : 'x')); b.doc = b.doc.replace(b.evidence, e2); b.evidence = e2; }],
  ['document', (b) => { b.doc = b.doc.replace(/\d/, (d) => String((Number(d) + 1) % 10)); }],
]) {
  test(`proof page detects a tampered ${what}`, async ({ page }) => {
    const s = slashes[0];
    await page.route(`**/tenders/${s.id}.json`, async (route) => {
      const res = await route.fetch();
      const r = await res.json();
      const before = JSON.stringify(r.bids[s.label]);
      mutate(r.bids[s.label]);
      expect(JSON.stringify(r.bids[s.label])).not.toBe(before); // the mutation must actually change something
      await route.fulfill({ response: res, json: r });
    });
    await page.goto(`/slash.html?t=${s.id}&b=${encodeURIComponent(s.label)}`);
    const v = await verdict(page);
    test.skip(v.includes("Couldn't reach"), 'Kite RPC unreachable');
    expect(v).toContain('✗ Something does not match Kite testnet');
  });
}

test('proof page refuses a bid that was not slashed', async ({ page }) => {
  const t = index.find((x) => x.featured);
  const clean = Object.values(JSON.parse(readFileSync(`public/tenders/${t.id}.json`, 'utf8')).bids).find((b) => !b.slash);
  await page.goto(`/slash.html?t=${t.id}&b=${encodeURIComponent(clean.label)}`);
  await expect(page.locator('#view')).toContainText('That bid was not slashed.');
});

test('proof page shows the appeal outcome and who paid for the audits', async ({ page }) => {
  const appealed = slashes.find((s) => JSON.parse(readFileSync(`public/tenders/${s.id}.json`, 'utf8')).bids[s.label].appeal);
  test.skip(!appealed, 'no appealed slash published');
  const a = JSON.parse(readFileSync(`public/tenders/${appealed.id}.json`, 'utf8')).bids[appealed.label].appeal;
  await page.goto(`/slash.html?t=${appealed.id}&b=${encodeURIComponent(appealed.label)}`);
  await expect(page.locator('#view')).toContainText({ upheld: 'Slash upheld', overturned: 'Slash overturned', human: 'a named approver decides' }[a.outcome]);
  await expect(page.locator('#fund')).toContainText('% paid by attackers');
});

// A repeat offender that locked the quoted (higher) bond is shown competing normally, with what it locked.
test('escalated bond: a repeat offender that paid for its second chance is shown competing normally', async ({ page }) => {
  const t = index.find((x) => Object.values(JSON.parse(readFileSync(`public/tenders/${x.id}.json`, 'utf8')).bids)
    .some((b) => b.priorSlashes?.length && b.bondPie >= b.bondRequired));
  test.skip(!t, 'no published tender with an escalated bond');
  const bid = Object.values(JSON.parse(readFileSync(`public/tenders/${t.id}.json`, 'utf8')).bids).find((b) => b.priorSlashes?.length);
  await page.goto('/');
  await page.locator(`#tenders button[data-id="${t.id}"]`).click();
  await expect.poll(() => shown(page)).toBe(t.id);
  await expect(page.locator('.bid', { hasText: bid.label })).toContainText(`bond locked ${bid.bondPie} of ${bid.bondRequired} required · competes normally`);
});
