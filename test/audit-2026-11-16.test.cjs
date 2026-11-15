// Free audit 2026-11-16 (docs/reports/free-audit-2026-11-16.md). Each test either DEMONSTRATES a finding (F*) on the
// deployed contract as-is, or tries an attack and shows it fails (D*). Tests for findings pass because they assert the
// current (flawed) behaviour; if the contract is patched, flip the assertion.
const { expect } = require('chai');
const { ethers } = require('hardhat');
const { time } = require('@nomicfoundation/hardhat-toolbox/network-helpers');

const H = (s) => ethers.keccak256(ethers.toUtf8Bytes(s));
const salt = (n) => ethers.zeroPadValue(ethers.toBeHex(n), 32);
const COMMIT = 3600, REVEAL = 3600, SETTLE = 86400, CHALLENGE = 3600;
const BOND = 100n;
const TREASURY = ethers.getAddress('0x' + 'fe'.repeat(20));

async function setup(tokenName = 'TestToken', feeBps = 0) {
  const signers = await ethers.getSigners();
  const [buyer, a, b, c] = signers;
  const approvers = signers.slice(10, 12);
  const token = await ethers.deployContract(tokenName);
  const escrow = await ethers.deployContract('LelangEscrow', [TREASURY, approvers.map((x) => x.address), 2, CHALLENGE]);
  const addr = await escrow.getAddress();
  for (const s of [buyer, a, b, c]) {
    await token.mint(s.address, 10n ** 24n);
    await token.connect(s).approve(addr, ethers.MaxUint256);
  }
  await escrow.open(await token.getAddress(), BOND, COMMIT, REVEAL, SETTLE, feeBps);
  return { escrow, token, addr, buyer, a, b, c, approvers, id: 1n };
}
async function commitAs(escrow, s, id, doc, n, amount = BOND) {
  await escrow.connect(s).commit(id, await escrow.commitmentOf(H(doc), salt(n), s.address, id), amount);
}
const reveal = (escrow, s, id, doc, n) => escrow.connect(s).reveal(id, H(doc), salt(n));

describe('Free audit 2026-11-16', () => {
  describe('findings (demonstrated on the deployed code)', () => {
    it('F1: if nobody reveals, settle is impossible and every non-revealer withdraws its full bond (no penalty)', async () => {
      const { escrow, token, a, b, c, id } = await setup();
      for (const [i, s] of [a, b, c].entries()) await commitAs(escrow, s, id, `d${i}`, i);
      await time.increase(COMMIT + REVEAL);
      for (const s of [a, b, c]) await expect(escrow.settle(id, s.address, [], [], 0, 0, 0)).to.be.revertedWithCustomError(escrow, 'InvalidWinner');
      await time.increase(SETTLE);
      const a0 = await token.balanceOf(a.address);
      await escrow.connect(a).withdraw(id);
      expect(await token.balanceOf(a.address)).to.equal(a0 + BOND); // full bond back, never revealed
    });

    it('F1: an attacker filling all MAX_BIDDERS slots and never revealing blocks the tender at no cost but gas', async () => {
      const { escrow, token, addr, buyer, a, id } = await setup();
      const wallets = [];
      for (let i = 0; i < 100; i++) {
        const w = ethers.Wallet.createRandom().connect(ethers.provider);
        await buyer.sendTransaction({ to: w.address, value: ethers.parseEther('0.1') });
        await token.mint(w.address, BOND);
        await token.connect(w).approve(addr, BOND);
        wallets.push(w);
      }
      for (const [i, w] of wallets.entries()) await commitAs(escrow, w, id, `junk${i}`, i);
      await expect(commitAs(escrow, a, id, 'honest', 999)).to.be.revertedWithCustomError(escrow, 'TooManyBidders');
      await time.increase(COMMIT + REVEAL + SETTLE);
      for (const w of wallets) await escrow.connect(w).withdraw(id);
      for (const w of wallets.slice(0, 5)) expect(await token.balanceOf(w.address)).to.equal(BOND); // attacker made whole
    });

    it('F2: one revealed bidder the token refuses to pay (blocklist) reverts the whole settle; listing it as a slash is the only way out', async () => {
      const { escrow, token, a, b, approvers, id } = await setup('BlocklistToken');
      await commitAs(escrow, a, id, 'a', 1);
      await commitAs(escrow, b, id, 'b', 2);
      await escrow.closeCommits(id);
      await reveal(escrow, a, id, 'a', 1);
      await reveal(escrow, b, id, 'b', 2);
      await token.setBlocked(b.address, true);
      await expect(escrow.settle(id, a.address, [], [], 0, 0, 0)).to.be.revertedWith('blocked');
      // Workaround: the buyer lists b as a slash (b did nothing wrong); then even a quorum overturn cannot pay b.
      await escrow.settle(id, a.address, [b.address], [H('cannot pay b')], 0, 0, 0);
      await escrow.connect(approvers[0]).overturnSlash(id, b.address);
      await expect(escrow.connect(approvers[1]).overturnSlash(id, b.address)).to.be.revertedWith('blocked');
    });

    it('F3: fee-on-transfer tokens: the escrow books more than it received, so the last refund fails (one bidder pays for another)', async () => {
      const { escrow, token, addr, a, b, id } = await setup('FeeOnTransferToken');
      await commitAs(escrow, a, id, 'a', 1, 10_000n);
      await commitAs(escrow, b, id, 'b', 2, 10_000n);
      expect(await token.balanceOf(addr)).to.equal(19_800n); // 20_000 booked
      await escrow.closeCommits(id);
      await reveal(escrow, a, id, 'a', 1);
      await reveal(escrow, b, id, 'b', 2);
      await expect(escrow.settle(id, a.address, [], [], 0, 0, 0)).to.be.revertedWithCustomError(token, 'ERC20InsufficientBalance');
      await time.increase(REVEAL + SETTLE);
      await escrow.connect(a).withdraw(id); // a gets its 10_000 out, partly from b's bond
      await expect(escrow.connect(b).withdraw(id)).to.be.revertedWithCustomError(token, 'ERC20InsufficientBalance');
    });

    it('F4: a zero commitment is accepted, can be repeated, and strands the earlier bonds (not in any pool, unwithdrawable)', async () => {
      const { escrow, token, addr, a, b, id } = await setup();
      await escrow.connect(a).commit(id, ethers.ZeroHash, BOND);
      await escrow.connect(a).commit(id, ethers.ZeroHash, BOND); // no AlreadyCommitted
      expect((await escrow.tenders(id)).committed).to.equal(2n);
      expect(await escrow.biddersOf(id)).to.deep.equal([a.address, a.address]);
      await commitAs(escrow, b, id, 'b', 2);
      await time.increase(COMMIT);
      await reveal(escrow, b, id, 'b', 2);
      await expect(reveal(escrow, a, id, 'x', 0)).to.be.revertedWithCustomError(escrow, 'BadReveal');
      await time.increase(REVEAL);
      await escrow.settle(id, b.address, [], [], 0, 0, 0);
      const pool = await escrow.bountyPool(await token.getAddress());
      expect(pool).to.equal(BOND); // only one of a's two bonds reached the pool
      expect(await token.balanceOf(addr)).to.equal(pool + BOND); // the other BOND is stranded for good
    });

    it('F5 (info): the commitment does not bind the escrow address or chain, so it is valid on every deployment', async () => {
      const { escrow, a, approvers } = await setup();
      const other = await ethers.deployContract('LelangEscrow', [TREASURY, approvers.map((x) => x.address), 2, CHALLENGE]);
      expect(await other.commitmentOf(H('doc'), salt(1), a.address, 1n)).to.equal(await escrow.commitmentOf(H('doc'), salt(1), a.address, 1n));
    });

    it('F6 (info): the treasury alone can move the whole bounty pool to any address, itself included', async () => {
      const { escrow, token, a, b, id } = await setup();
      await commitAs(escrow, a, id, 'a', 1);
      await commitAs(escrow, b, id, 'b', 2);
      await time.increase(COMMIT);
      await reveal(escrow, a, id, 'a', 1);
      await time.increase(REVEAL);
      await escrow.settle(id, a.address, [], [], 0, 0, 0); // b forfeits
      await ethers.provider.send('hardhat_impersonateAccount', [TREASURY]);
      await ethers.provider.send('hardhat_setBalance', [TREASURY, '0xde0b6b3a7640000']);
      const t = await ethers.getSigner(TREASURY);
      await escrow.connect(t).payBounty(await token.getAddress(), TREASURY, BOND, H('anything'));
      expect(await token.balanceOf(TREASURY)).to.equal(BOND);
    });
  });

  describe('attempted attacks that fail (disproven)', () => {
    it('D1: a token callback re-entering the escrow during a settle refund is blocked by the global lock', async () => {
      const { escrow, token, addr, a, b, id } = await setup('ReentrantToken');
      // Tender 1: b's slash becomes finalizable.
      await commitAs(escrow, a, id, 'a', 1);
      await commitAs(escrow, b, id, 'b', 2);
      await escrow.closeCommits(id);
      await reveal(escrow, a, id, 'a', 1);
      await reveal(escrow, b, id, 'b', 2);
      await escrow.settle(id, a.address, [b.address], [H('e')], 0, 0, 0);
      await time.increase(CHALLENGE);
      // Tender 2: during a's refund the token tries finalizeSlash(1, b), which would succeed outside the lock.
      await escrow.open(await token.getAddress(), BOND, COMMIT, REVEAL, SETTLE, 0);
      await commitAs(escrow, a, 2n, 'a2', 3);
      await escrow.closeCommits(2n);
      await reveal(escrow, a, 2n, 'a2', 3);
      await token.arm(addr, escrow.interface.encodeFunctionData('finalizeSlash', [1n, b.address]));
      await escrow.settle(2n, a.address, [], [], 0, 0, 0);
      expect(await token.attempted()).to.equal(true);
      expect(await token.reentered()).to.equal(false);
      await expect(escrow.finalizeSlash(1n, b.address)).to.emit(escrow, 'BondSlashed'); // works outside the lock
    });

    it('D2: a copied commitment cannot be revealed by the copier, nor reused in another tender', async () => {
      const { escrow, a, b, id } = await setup();
      const ca = await escrow.commitmentOf(H('a'), salt(1), a.address, id);
      await escrow.connect(a).commit(id, ca, BOND);
      await escrow.connect(b).commit(id, ca, BOND); // b copies a's sealed bid
      await escrow.open((await escrow.tenders(id)).token, BOND, COMMIT, REVEAL, SETTLE, 0);
      const id2 = await escrow.tenderCount();
      await escrow.connect(a).commit(id2, ca, BOND); // a replays its own commitment in tender 2
      await time.increase(COMMIT);
      await expect(reveal(escrow, b, id, 'a', 1)).to.be.revertedWithCustomError(escrow, 'BadReveal');
      await expect(reveal(escrow, a, id2, 'a', 1)).to.be.revertedWithCustomError(escrow, 'BadReveal');
      await reveal(escrow, a, id, 'a', 1);
    });

    it('D3: challenge window edges: finalize rejected at finalAt-1, overturn rejected at finalAt, finalize once', async () => {
      const { escrow, a, b, approvers, id } = await setup();
      await commitAs(escrow, a, id, 'a', 1);
      await commitAs(escrow, b, id, 'b', 2);
      await escrow.closeCommits(id);
      await reveal(escrow, a, id, 'a', 1);
      await reveal(escrow, b, id, 'b', 2);
      await escrow.settle(id, a.address, [b.address], [H('e')], 0, 0, 0);
      const { finalAt } = await escrow.pendingSlash(id, b.address);
      await escrow.connect(approvers[0]).overturnSlash(id, b.address);
      await time.setNextBlockTimestamp(finalAt - 1n);
      await expect(escrow.finalizeSlash(id, b.address)).to.be.revertedWithCustomError(escrow, 'WrongPhase');
      await time.setNextBlockTimestamp(finalAt);
      await expect(escrow.connect(approvers[1]).overturnSlash(id, b.address)).to.be.revertedWithCustomError(escrow, 'WrongPhase');
      await expect(escrow.finalizeSlash(id, b.address)).to.emit(escrow, 'BondSlashed');
      await expect(escrow.finalizeSlash(id, b.address)).to.be.revertedWithCustomError(escrow, 'WrongPhase');
    });

    it('D4: votes do not carry across bidders or tenders; one approver cannot reach quorum', async () => {
      const { escrow, token, a, b, c, approvers, id } = await setup();
      await commitAs(escrow, a, id, 'a', 1);
      await commitAs(escrow, b, id, 'b', 2);
      await commitAs(escrow, c, id, 'c', 3);
      await escrow.closeCommits(id);
      for (const [i, s] of [a, b, c].entries()) await reveal(escrow, s, id, 'abc'[i], i + 1);
      await escrow.settle(id, a.address, [b.address, c.address], [H('e1'), H('e2')], 0, 0, 0);
      await escrow.connect(approvers[0]).overturnSlash(id, b.address);
      await expect(escrow.connect(approvers[0]).overturnSlash(id, b.address)).to.be.revertedWithCustomError(escrow, 'AlreadyVoted');
      await escrow.connect(approvers[1]).overturnSlash(id, c.address); // different bidder: 1 vote each, no quorum
      expect((await escrow.pendingSlash(id, b.address)).finalAt).to.not.equal(0n);
      expect((await escrow.pendingSlash(id, c.address)).finalAt).to.not.equal(0n);
      expect(await token.balanceOf(await escrow.getAddress())).to.equal(2n * BOND);
    });

    it('D5: fee math: treasury gets exactly floor(amount*bps/10000) of down payment and balance; dust rounds to zero', async () => {
      const { escrow, token, buyer, a, id } = await setup('TestToken', 500);
      await commitAs(escrow, a, id, 'a', 1);
      await escrow.closeCommits(id);
      await reveal(escrow, a, id, 'a', 1);
      const dp = 12_345n, bal = 19n; // 19 * 500 / 10000 = 0.95 -> 0
      const b0 = await token.balanceOf(buyer.address);
      await escrow.settle(id, a.address, [], [], dp, bal, 100);
      expect(await token.balanceOf(TREASURY)).to.equal((dp * 500n) / 10_000n);
      expect(b0 - (await token.balanceOf(buyer.address))).to.equal(dp + (dp * 500n) / 10_000n + bal);
      await escrow.confirmDelivery(id);
      expect(await token.balanceOf(TREASURY)).to.equal((dp * 500n) / 10_000n); // balance fee rounded to 0
    });

    it('D6: phase edges: withdraw rejected at settleDeadline-1, settle rejected at settleDeadline, withdraw works; no commit after close', async () => {
      const { escrow, a, b, id } = await setup();
      await commitAs(escrow, a, id, 'a', 1);
      await escrow.closeCommits(id);
      await expect(commitAs(escrow, b, id, 'b', 2)).to.be.revertedWithCustomError(escrow, 'WrongPhase');
      await reveal(escrow, a, id, 'a', 1);
      const { settleDeadline } = await escrow.tenders(id);
      await time.setNextBlockTimestamp(settleDeadline - 1n);
      await expect(escrow.connect(a).withdraw(id)).to.be.revertedWithCustomError(escrow, 'WrongPhase');
      await time.setNextBlockTimestamp(settleDeadline);
      await expect(escrow.settle(id, a.address, [], [], 0, 0, 0)).to.be.revertedWithCustomError(escrow, 'WrongPhase');
      await escrow.connect(a).withdraw(id);
    });

    it('D7: duplicates and strangers in the slash list are handled once or skipped; the winner cannot be listed', async () => {
      const { escrow, a, b, c, id } = await setup();
      await commitAs(escrow, a, id, 'a', 1);
      await commitAs(escrow, b, id, 'b', 2);
      await escrow.closeCommits(id);
      await reveal(escrow, a, id, 'a', 1);
      await reveal(escrow, b, id, 'b', 2);
      await expect(escrow.settle(id, a.address, [a.address], [H('e')], 0, 0, 0)).to.be.revertedWithCustomError(escrow, 'InvalidWinner');
      const tx = escrow.settle(id, a.address, [b.address, b.address, c.address], [H('e1'), H('e2'), ethers.ZeroHash], 0, 0, 0);
      await expect(tx).to.emit(escrow, 'SlashPending').withArgs(id, b.address, BOND, H('e1'), (x) => true);
      const r = await (await tx).wait();
      expect(r.logs.filter((l) => escrow.interface.parseLog(l)?.name === 'SlashPending').length).to.equal(1);
    });

    it('D8: worst-case settle (100 bidders, all revealed, 100 refund transfers) stays far under a block', async () => {
      const { escrow, token, addr, buyer, id } = await setup();
      const wallets = [];
      for (let i = 0; i < 100; i++) {
        const w = ethers.Wallet.createRandom().connect(ethers.provider);
        await buyer.sendTransaction({ to: w.address, value: ethers.parseEther('0.1') });
        await token.mint(w.address, BOND);
        await token.connect(w).approve(addr, BOND);
        wallets.push(w);
      }
      for (const [i, w] of wallets.entries()) await commitAs(escrow, w, id, `d${i}`, i);
      await escrow.closeCommits(id);
      for (const [i, w] of wallets.entries()) await reveal(escrow, w, id, `d${i}`, i);
      const { gasUsed } = await (await escrow.settle(id, wallets[0].address, [], [], 0, 0, 0)).wait();
      console.log(`      settle gas, 100 revealed bidders: ${gasUsed}`);
      expect(gasUsed).to.be.lessThan(10_000_000n);
    });
  });
});
