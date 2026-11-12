// Open Contracting Data Standard 1.1 release package for a tender (https://standard.open-contracting.org/1.1/).
// Bid details use the official Bid statistics and details extension. Lelang-specific proof (escrow, tx hashes,
// audit verdicts) goes under `x_lelang`, since OCDS allows additional fields.
const BIDS_EXTENSION = 'https://raw.githubusercontent.com/open-contracting-extensions/ocds_bid_extension/v1.1.5/extension.json';

export function toOcds(rfq, { buyer, escrow } = {}) {
  const ocid = `ocds-lelang-${rfq.id}`;
  const bids = Object.values(rfq.bids);
  const usd = (amount) => (Number.isFinite(amount) ? { amount, currency: 'USD' } : undefined);
  const party = (b) => ({ id: b.supplier, name: `${b.label} (supplier agent)` });
  const winner = rfq.phase === 'settled' ? rfq.bids[rfq.award?.winner] : null;
  const buyerParty = { id: buyer ?? 'lelang-buyer', name: 'Buyer agent' };

  const release = {
    ocid,
    id: `${rfq.id}-${rfq.phase}`,
    date: rfq.events.at(-1)?.t ?? rfq.createdAt,
    tag: winner ? ['tender', 'award'] : ['tender'],
    initiationType: 'tender',
    language: 'en',
    parties: [
      { ...buyerParty, roles: ['buyer', 'procuringEntity'] },
      ...bids.map((b) => ({ ...party(b), roles: b === winner ? ['tenderer', 'supplier'] : ['tenderer'] })),
    ],
    buyer: buyerParty,
    tender: {
      id: rfq.id,
      title: rfq.title,
      status: winner ? 'complete' : 'active',
      value: usd(rfq.budgetCapUsd),
      procurementMethod: 'open',
      procurementMethodDetails: 'Sealed-bid tender between agents: commit-reveal on Kite, bonds in escrow',
      awardCriteria: 'ratedCriteria',
      awardCriteriaDetails: `Weights ${JSON.stringify(rfq.weights)}; minimum specs ${JSON.stringify(rfq.minSpecs)}; max delivery ${rfq.maxDeliveryDays} days`,
      submissionMethod: ['electronicSubmission'],
      tenderPeriod: { startDate: rfq.createdAt },
      numberOfTenderers: bids.length,
      tenderers: bids.map(party),
    },
    bids: {
      details: bids.map((b) => ({
        id: b.label,
        status: b.disqualified ? 'disqualified' : 'valid',
        tenderers: [party(b)],
        ...(usd(b.terms?.total_usd) && { value: usd(b.terms.total_usd) }),
      })),
    },
    ...(winner && {
      awards: [{
        id: `${rfq.id}-award`,
        status: 'active',
        date: rfq.events.findLast((e) => e.step === 'settle')?.t,
        value: usd(winner.terms?.total_usd),
        suppliers: [party(winner)],
        description: rfq.award.rationale,
      }],
    }),
    x_lelang: {
      escrow: escrow ?? rfq.escrow ?? null,
      escrowTenderId: rfq.chainId ?? null,
      commitsClosedTx: rfq.anchorTx ?? null,
      bids: bids.map((b) => ({ id: b.label, commitment: b.hash, docHash: b.docHash, revealOk: b.revealOk, disqualified: b.disqualified ?? null, evidence: b.evidence ?? null, evidenceHash: b.evidenceHash ?? null })),
      decision: rfq.award && { decision: rfq.award.decision, formulaScores: rfq.award.scores, probabilities: rfq.award.probabilities, engine: rfq.award.engine },
      audit: rfq.reppo ?? null,
      humanApproval: rfq.humanApproval ?? null,
      settlement: rfq.settlement ?? [],
    },
  };
  return {
    uri: `https://lelang-ten.vercel.app/ocds/${rfq.id}.json`,
    version: '1.1',
    publishedDate: release.date,
    publisher: { name: 'Lelang' },
    extensions: [BIDS_EXTENSION],
    releases: [release],
  };
}
