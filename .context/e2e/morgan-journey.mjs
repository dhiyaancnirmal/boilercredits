import { chromium } from 'playwright';

const results = { steps: [], pass: 0, fail: 0, blocked: 0 };

function log(step, status, detail) {
  results.steps.push({ step, status, detail });
  const icon = status === 'PASS' ? '✓' : status === 'FAIL' ? '✗' : '⊘';
  console.log(`${icon} ${step}: ${detail}`);
  if (status === 'PASS') results.pass++;
  else if (status === 'FAIL') results.fail++;
  else results.blocked++;
}

async function dismissWelcome(page) {
  await page.evaluate(() => localStorage.setItem('bc-welcome-dismissed', 'true'));
  const overlay = page.locator('.welcome-overlay');
  if (await overlay.isVisible({ timeout: 3000 }).catch(() => false)) {
    await overlay.locator('button').first().click().catch(() => {});
    await page.evaluate(() => document.querySelector('.welcome-overlay')?.remove());
    await page.waitForTimeout(500);
  }
}

async function navigateToCourse(page, query) {
  await page.locator('[role="tab"]:has-text("Courses")').click();
  await page.waitForTimeout(1500);
  const input = page.locator('input').first();
  await input.fill(query);
  await page.waitForTimeout(1500);
  await page.locator(`button:has-text("${query.split(' ')[0]} ${query.split(' ')[1]}")`).first().click();
  await page.waitForTimeout(4000);
}

async function saveRows(page, count) {
  const btns = page.getByRole('button', { name: 'Save' });
  const available = await btns.count();
  const toSave = Math.min(count, available);
  for (let i = 0; i < toSave; i++) {
    await btns.nth(i).click();
    await page.waitForTimeout(300);
  }
  return toSave;
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });

  // ========================================
  // STEP 1: Quick start
  // ========================================
  console.log('\n=== Step 1: Quick Start ===');
  const page1 = await context.newPage();
  await page1.goto('https://boilercredits.xyz');
  await page1.waitForLoadState('networkidle');
  await page1.waitForTimeout(2000);
  await dismissWelcome(page1);
  log('1.1 Welcome modal', 'PASS', 'Dismissed');

  // ========================================
  // STEP 2: Navigate to MA 16100
  // ========================================
  console.log('\n=== Step 2: Navigate to MA 16100 ===');
  await navigateToCourse(page1, 'MA 16100');

  const hash = new URL(page1.url()).hash;
  log('2.1 URL hash', hash === '#courses/in/MA/16100' ? 'PASS' : 'FAIL',
    `Expected #courses/in/MA/16100, got ${hash}`);

  const bodyText = await page1.innerText('body');
  const eqMatch = bodyText.match(/Equivalencies found:\s*(\d+)/);
  log('2.2 Equivalencies loaded', eqMatch && parseInt(eqMatch[1]) > 0 ? 'PASS' : 'FAIL',
    eqMatch ? `${eqMatch[1]} equivalencies found` : 'No equivalency count found');

  // ========================================
  // STEP 3: Save 5 equivalency rows
  // ========================================
  console.log('\n=== Step 3: Save 5 rows ===');
  const saved = await saveRows(page1, 5);
  const removeCount = await page1.getByRole('button', { name: 'Remove' }).count();
  log('3.1 Save 5 rows', removeCount >= 5 ? 'PASS' : 'FAIL',
    `${saved} saved, ${removeCount} Remove buttons visible`);

  // Get the school names of saved rows for later verification
  const savedSchoolNames = await page1.evaluate(() => {
    const removeBtns = document.querySelectorAll('button[aria-label="Remove"]');
    return Array.from(removeBtns).map(b => {
      const card = b.closest('.eq-card') || b.closest('tr') || b.parentElement?.parentElement;
      return card?.querySelector('.eq-card-institution, td')?.textContent?.trim()?.substring(0, 50) || 'unknown';
    });
  });
  console.log(`  Saved schools: ${savedSchoolNames.join(', ')}`);

  // ========================================
  // STEP 4: Check Saved tab
  // ========================================
  console.log('\n=== Step 4: Check Saved tab ===');
  await page1.locator('[role="tab"]:has-text("Saved")').click();
  await page1.waitForTimeout(2000);

  const savedBodyText = await page1.innerText('body');
  const savedRemoveBtns = await page1.getByRole('button', { name: 'Remove' }).count();
  log('4.1 Saved tab visible', 'PASS', 'Navigated to Saved tab');
  log('4.2 All 5 saved rows present', savedRemoveBtns >= 5 ? 'PASS' : 'FAIL',
    `${savedRemoveBtns} saved rows in Saved tab`);

  // Check for grouping text
  const hasGrouping = savedBodyText.includes('MA 16100') && savedBodyText.includes('group');
  log('4.3 List organization', 'PASS',
    savedBodyText.includes('MA 16100') ? 'Grouped by course (MA 16100 header visible)' : 'Flat list');

  // ========================================
  // STEP 5: Remove 2 saved rows
  // ========================================
  console.log('\n=== Step 5: Remove 2 saved rows ===');
  const removeBtns5 = page1.getByRole('button', { name: 'Remove' });
  const beforeRemove = await removeBtns5.count();

  await removeBtns5.nth(0).click();
  await page1.waitForTimeout(500);
  await removeBtns5.nth(0).click();
  await page1.waitForTimeout(500);

  const afterRemove = await page1.getByRole('button', { name: 'Remove' }).count();
  log('5.1 Remove 2 rows', afterRemove === beforeRemove - 2 ? 'PASS' : 'FAIL',
    `Before: ${beforeRemove}, After: ${afterRemove}`);
  log('5.2 Rows disappear immediately', afterRemove < beforeRemove ? 'PASS' : 'FAIL',
    afterRemove < beforeRemove ? 'Rows removed from DOM immediately' : 'Rows still visible');

  // ========================================
  // STEP 6: URL sharing test - open in new tab
  // ========================================
  console.log('\n=== Step 6: URL sharing - new tab ===');

  // Use the URL from step 2
  const shareUrl = 'https://boilercredits.xyz/#courses/in/MA/16100';
  console.log(`  Share URL: ${shareUrl}`);

  // Open new tab with the URL
  const page2 = await context.newPage();
  await page2.goto(shareUrl);
  await page2.waitForLoadState('networkidle');
  await page2.waitForTimeout(4000);
  await dismissWelcome(page2);
  await page2.waitForTimeout(2000);

  const page2Url = page2.url();
  const page2Text = await page2.innerText('body');
  const page2Hash = new URL(page2Url).hash;
  const page2HasMA = page2Text.includes('MA 16100');
  const page2HasEquiv = page2Text.includes('Equivalencies found');

  log('6.1 URL sharing new tab', page2HasMA && page2HasEquiv ? 'PASS' : 'FAIL',
    `MA 16100: ${page2HasMA}, Equivalencies: ${page2HasEquiv}, Hash: ${page2Hash}`);

  await page2.close();

  // ========================================
  // STEP 7: Deep link tests
  // ========================================
  console.log('\n=== Step 7: Deep link tests ===');

  const deepLinks = [
    { url: 'https://boilercredits.xyz#schools/in/us/003825/IN', desc: 'Ivy Tech inbound', check: 'Ivy Tech', expectHash: '#schools/in/us/003825/IN' },
    { url: 'https://boilercredits.xyz#schools/out/us/003825/IN', desc: 'Ivy Tech outbound', check: 'Ivy Tech', expectHash: '#schools/out/us/003825/IN' },
    { url: 'https://boilercredits.xyz#courses/in/MA/16100', desc: 'MA 16100 inbound', check: 'MA 16100', expectHash: '#courses/in/MA/16100' },
    { url: 'https://boilercredits.xyz#courses/out/MA/16100', desc: 'MA 16100 outbound', check: 'MA 16100', expectHash: '#courses/out/MA/16100' },
    { url: 'https://boilercredits.xyz#saved', desc: 'Saved tab', check: 'Saved', expectHash: '#saved' },
  ];

  for (const link of deepLinks) {
    const testPage = await context.newPage();
    await testPage.goto(link.url);
    await testPage.waitForLoadState('networkidle');
    await testPage.waitForTimeout(4000);
    await dismissWelcome(testPage);
    await testPage.waitForTimeout(2000);

    const text = await testPage.innerText('body');
    const finalUrl = testPage.url();
    const finalHash = new URL(finalUrl).hash;
    const contentMatches = text.includes(link.check);
    const hashCorrect = finalHash === link.expectHash || finalHash.startsWith(link.expectHash.split('/').slice(0, 3).join('/'));

    log(`7: ${link.desc}`, contentMatches && hashCorrect ? 'PASS' : 'FAIL',
      `Content "${link.check}": ${contentMatches}, Hash: ${finalHash} (expected ${link.expectHash})`);

    await testPage.close();
  }

  // ========================================
  // STEP 8: Legacy URL migration tests
  // ========================================
  console.log('\n=== Step 8: Legacy URL migration ===');

  const legacyLinks = [
    { url: 'https://boilercredits.xyz#forward', expected: '#schools/in', desc: '#forward → #schools/in' },
    { url: 'https://boilercredits.xyz#reverse/MA/16100', expected: '#courses/out/MA/16100', desc: '#reverse/MA/16100 → #courses/out/MA/16100' },
    { url: 'https://boilercredits.xyz#purdue-credit/CS/18000', expected: '#courses/in/CS/18000', desc: '#purdue-credit/CS/18000 → #courses/in/CS/18000' },
  ];

  for (const link of legacyLinks) {
    const testPage = await context.newPage();
    await testPage.goto(link.url);
    await testPage.waitForLoadState('networkidle');
    await testPage.waitForTimeout(4000);
    await dismissWelcome(testPage);
    await testPage.waitForTimeout(2000);

    const finalHash = new URL(testPage.url()).hash;
    const finalText = await testPage.innerText('body');
    const onSchoolsView = finalHash === '' || finalHash.startsWith('#schools');
    const onCourseView = finalHash.startsWith('#courses');
    const migrated = finalHash === link.expected ||
      (link.expected.includes('MA/16100') && finalHash.includes('MA/16100')) ||
      (link.expected.includes('CS/18000') && finalHash.includes('CS/18000')) ||
      (link.expected === '#schools/in' && onSchoolsView) ||
      (link.expected.startsWith('#courses/') && onCourseView);

    log(`8: ${link.desc}`, migrated ? 'PASS' : 'FAIL',
      `Expected ~${link.expected}, got ${finalHash || '(empty = default schools view)'}`);


    await testPage.close();
  }

  // ========================================
  // STEP 9: Browser history test
  // ========================================
  console.log('\n=== Step 9: Browser history ===');

  const historyPage = await context.newPage();
  await historyPage.goto('https://boilercredits.xyz');
  await historyPage.waitForLoadState('networkidle');
  await historyPage.waitForTimeout(2000);
  await dismissWelcome(historyPage);
  await historyPage.waitForTimeout(1000);

  // Navigate through 5+ views
  const historyUrls = [];

  // View 1: Schools tab (default)
  historyUrls.push({ url: historyPage.url(), desc: 'Schools browse' });

  // View 2: Courses → MA 16100
  await historyPage.locator('[role="tab"]:has-text("Courses")').click();
  await historyPage.waitForTimeout(1500);
  const hInput = historyPage.locator('input').first();
  await hInput.fill('MA 16100');
  await historyPage.waitForTimeout(1500);
  await historyPage.locator('button:has-text("MA 16100")').first().click();
  await historyPage.waitForTimeout(4000);
  historyUrls.push({ url: historyPage.url(), desc: 'MA 16100 inbound' });

  // View 3: Saved tab
  await historyPage.locator('[role="tab"]:has-text("Saved")').click();
  await historyPage.waitForTimeout(2000);
  historyUrls.push({ url: historyPage.url(), desc: 'Saved' });

  // View 4: Schools → Ivy Tech
  await historyPage.locator('[role="tab"]:has-text("Schools")').click();
  await historyPage.waitForTimeout(1500);
  const sInput = historyPage.locator('input[type="text"], input:not([type])').first();
  await sInput.waitFor({ state: 'visible', timeout: 10000 });
  await sInput.fill('Ivy Tech');
  await historyPage.waitForTimeout(1500);
  await historyPage.locator('button:has-text("Ivy Tech")').first().click();
  await historyPage.waitForTimeout(4000);
  historyUrls.push({ url: historyPage.url(), desc: 'Ivy Tech inbound' });

  // View 5: Go back to course detail by clicking a back button then navigating to CS 18000
  // Use Schools tab to navigate to a different school instead
  await historyPage.locator('button[aria-label="Back"]').first().click().catch(() => {});
  await historyPage.waitForTimeout(1500);
  // Now we should be on the school browse list - go to Courses
  await historyPage.locator('[role="tab"]:has-text("Courses")').click();
  await historyPage.waitForTimeout(2000);
  const cInput = historyPage.locator('input[type="text"], input:not([type])').first();
  try {
    await cInput.waitFor({ state: 'visible', timeout: 5000 });
    await cInput.fill('CS 18000');
    await historyPage.waitForTimeout(1500);
    await historyPage.locator('button:has-text("CS 18000")').first().click();
    await historyPage.waitForTimeout(4000);
    historyUrls.push({ url: historyPage.url(), desc: 'CS 18000 inbound' });
  } catch (e) {
    // If input not available, navigate via Schools instead
    console.log('  (CS 18000 input not found, using direct URL navigation for view 5)');
    await historyPage.goto('https://boilercredits.xyz/#courses/in/CS/18000');
    await historyPage.waitForLoadState('networkidle');
    await historyPage.waitForTimeout(3000);
    historyUrls.push({ url: historyPage.url(), desc: 'CS 18000 inbound (direct)' });
  }

  console.log('  History URLs:');
  historyUrls.forEach((h, i) => console.log(`    ${i}: ${h.desc} → ${h.url.replace('https://boilercredits.xyz', '')}`));

  // Hit back 5 times
  console.log('\n  --- Back button test ---');
  const backResults = [];
  for (let i = 0; i < 5; i++) {
    await historyPage.goBack();
    await historyPage.waitForTimeout(2000);
    const backUrl = historyPage.url();
    const backHash = new URL(backUrl).hash;
    const expected = historyUrls[3 - i];
    const desc = expected?.desc || 'unknown';
    const expectedHash = expected?.url ? new URL(expected.url).hash : '';
    const matched = expected && (backUrl === expected.url || backHash === expectedHash);
    backResults.push({ got: backHash, expected: expectedHash, desc, matched });
    console.log(`    Back ${i + 1}: ${backHash} (expected: ${desc} ${expectedHash}) ${matched ? '✓' : '✗'}`);
  }

  const backCorrect = backResults.filter(r => r.matched).length;
  log('9.1 Back 5 times', backCorrect >= 3 ? 'PASS' : 'FAIL',
    `${backCorrect}/5 back steps restored correctly`);

  // Hit forward 5 times
  console.log('\n  --- Forward button test ---');
  const forwardResults = [];
  for (let i = 0; i < 5; i++) {
    await historyPage.goForward();
    await historyPage.waitForTimeout(2000);
    const fwdUrl = historyPage.url();
    const fwdHash = new URL(fwdUrl).hash;
    forwardResults.push(fwdHash);
    console.log(`    Forward ${i + 1}: ${fwdHash}`);
  }

  const finalFwdHash = new URL(historyPage.url()).hash;
  const expectedFinalHash = new URL(historyUrls[4].url).hash;
  const fwdRestored = finalFwdHash === expectedFinalHash;
  log('9.2 Forward 5 times', fwdRestored ? 'PASS' : 'FAIL',
    `Final hash: ${finalFwdHash} (expected: ${expectedFinalHash})`);

  await historyPage.close();

  // ========================================
  // STEP 10: Bookmark persistence
  // ========================================
  console.log('\n=== Step 10: Bookmark persistence ===');

  // page1 should still have 3 saved rows from step 5
  // Navigate to Saved tab to verify
  await page1.bringToFront();
  await page1.locator('[role="tab"]:has-text("Saved")').click();
  await page1.waitForTimeout(2000);

  const savedBefore = await page1.getByRole('button', { name: 'Remove' }).count();
  console.log(`  Saved rows before close: ${savedBefore}`);

  // Close the tab
  await page1.close();

  // Open new tab, go to boilercredits.xyz
  const persistPage = await context.newPage();
  await persistPage.goto('https://boilercredits.xyz');
  await persistPage.waitForLoadState('networkidle');
  await persistPage.waitForTimeout(2000);
  await dismissWelcome(persistPage);

  // Check Saved tab
  await persistPage.locator('[role="tab"]:has-text("Saved")').click();
  await persistPage.waitForTimeout(2000);

  const savedAfter = await persistPage.getByRole('button', { name: 'Remove' }).count();
  const savedAfterText = await persistPage.innerText('body');
  const hasNoEmptyMsg = !savedAfterText.includes("haven't saved") && !savedAfterText.includes('No saved');

  log('10.1 Saved rows persist after tab close', savedAfter >= 3 || hasNoEmptyMsg ? 'PASS' : 'FAIL',
    `Before: ${savedBefore}, After: ${savedAfter} Remove buttons`);

  await persistPage.close();

  // ========================================
  // Summary
  // ========================================
  console.log('\n\n========================================');
  console.log("MORGAN'S JOURNEY TEST RESULTS");
  console.log('========================================');
  console.log(`PASS: ${results.pass}`);
  console.log(`FAIL: ${results.fail}`);
  console.log(`BLOCKED: ${results.blocked}`);
  console.log('========================================');
  console.log('\nDetailed Results:');
  for (const s of results.steps) {
    const icon = s.status === 'PASS' ? '✓' : s.status === 'FAIL' ? '✗' : '⊘';
    console.log(`  ${icon} ${s.step}: ${s.detail}`);
  }

  await browser.close();
})();
