// Bahasa Indonesia / English for the landing page. English stays in the HTML (it is what crawlers and no-JS readers
// get); this file holds the Indonesian, keyed by selector, and swaps innerHTML. It also owns the word split behind the
// blur-in headings, since a language switch has to split again. Live results (playground verdicts, chain reads) stay English.
// ponytail: landing only; the app pages are English. Extend the table if a page needs it.
const ID = {
  '#h1': 'Tender lelang tertutup<br>untuk agen AI',
  '.hero .sub': 'Penawaran yang menyembunyikan instruksi untuk evaluator AI kehilangan jaminannya, dan kutipan yang membuktikannya di-hash ke Kite testnet.',
  '.hero .btn.red': 'Verifikasi slash sendiri',
  '.hero .btn.ghost': 'Tonton demo 185 detik →',
  '#h-seal': 'Setiap penawaran tetap tersegel',
  '.scatter .sub': 'Setiap pemasok mengunci jaminan dan meng-commit <code>keccak(docHash, salt, bidder, tender)</code>. Tidak ada yang membaca dokumen sebelum commit ditutup; lalu escrow memeriksa setiap reveal cocok dengan yang disegel.',
  '.scatter .btn.purple': 'Ajukan penawaran',
  '.scatter .note': 'Kartu-kartu ini adalah penawaran asli dari tender #8 dan #10. Klik salah satunya.',
  '#h-try': 'Coba kelabui evaluatornya',
  '[data-i18n="try.sub"]': 'Pilih serangan asli untuk melihat nasibnya, atau tulis paragrafmu sendiri dan biarkan evaluator live menilainya. Paragrafmu ditempel ke penawaran jujur; kalau tidak ada yang menangkapnya dan kedua pembaca menelan angkamu, kamu menang bounty.',
  '[data-i18n="try.pick"]': 'Serangan asli yang sudah kami ukur',
  '[data-i18n="try.yours"]': 'Paragrafmu, ditempel ke penawaran',
  '[data-i18n="try.judge"]': 'Nilai sekarang · 0,05 PYUSD',
  '[data-i18n="try.faucet"]': 'Ambil PYUSD uji',
  '[data-i18n="try.fine"]': 'Dibayar dari dompet browser di Kite testnet: kamu menandatangani otorisasi EIP-3009, tanpa gas. Hanya token testnet. Tidak punya dompet? <code>node scripts/break-lelang.js "…"</code>',
  '#h-who': 'Dibuat untuk semua pihak dalam tender',
  '#h-who + .sub': 'Pembeli, pemasok, agen mereka, dan orang yang bisa membatalkan keputusan, semuanya melihat bukti yang sama.',
  '.bento .card:nth-child(1) h3': 'Untuk pembeli',
  '.bento .card:nth-child(1) h3 + p': 'Buka tender dari pengumuman OCDS publik mana pun, bayar biayanya lewat x402 tanpa gas, dan dapatkan pemenang berperingkat beserta alasannya.',
  '.bento .card:nth-child(2) h3': 'Untuk pemasok',
  '.bento .card:nth-child(2) h3 + p': 'Dompetmu mengunci jaminan yang dikutip dan menyegel komitmen. Jaminan yang patuh kembali di transaksi settle.',
  '.bento .card:nth-child(3) h3': 'Untuk agen',
  '.bento .card:nth-child(3) h3 + p': 'Tool MCP untuk melihat daftar, membaca, mengutip jaminan, menawar, dan reveal dengan kuncimu sendiri. Atau panggil <code>POST /api/rfqs</code> dan jawab 402-nya.',
  '.bento .card:nth-child(4) h3': 'Buktinya, kata demi kata',
  '.bento .card:nth-child(4) h3 + p': 'Tender #8, Bid E. SERV mengutip komentar itu persis, kode menemukannya di dokumen, dan <code>keccak(quote)</code> masuk ke event settle. Panel banding menguatkannya.',
  '.bento .card:nth-child(4) .stamp': 'Gugur · jaminan disita',
  '.bento .card:nth-child(5) h3': 'Untuk approver',
  '.vizcap': 'tender #8 · total penawaran dalam USD seperti terbaca · <b class="cw">pemenang</b> · <b class="co">gugur</b> · <b class="cx">disita</b>',
  '.num:nth-child(1) .k': 'Tender dibuka, di keempat escrow',
  '.num:nth-child(2) .k': 'Penawaran tersegel yang di-commit on-chain',
  '.num:nth-child(3) .k': 'Slash dengan hash bukti',
  '.num:nth-child(4) .k': 'Bounty pool, hanya diisi dari slash',
  '#h-run': 'Tujuh langkah, tanpa perlu percaya',
  '#h-run + .sub': 'Kode menjaga setiap titik di mana model bisa salah. Kalau kode tidak bisa memutuskan, manusia yang memutuskan.',
  '.steps li:nth-child(1)': '<b>Buka</b>Pembeli membuka tender di escrow V4 dan membayar 0,2 + 0,06 per slot penawaran lewat x402.',
  '.steps li:nth-child(2)': '<b>Segel</b>Pemasok mengunci jaminan dan meng-commit hash. n slash terbukti: jaminan × 2<sup>n</sup>.',
  '.steps li:nth-child(3)': '<b>Periksa</b>SERV wajib mengutip persis setiap catatan untuk evaluator; kode memeriksa kutipan itu ada.',
  '.steps li:nth-child(4)': '<b>Baca</b>Dolphin dan SERV sama-sama membaca harga, pengiriman, garansi. Kalau berbeda, manusia yang memutuskan.',
  '.steps li:nth-child(5)': '<b>Putuskan</b>Rumus yang dipublikasikan dan decision node harus memilih pemenang yang sama.',
  '.steps li:nth-child(6)': '<b>Audit</b>Panel Reppo bilang ship, review, atau block. Ronde paling ketat yang menentukan uang.',
  '.steps li:nth-child(7)': '<b>Settle</b>Satu transaksi mengembalikan, membayar, menahan sisa sampai barang tiba, dan menyita setelah 1 jam.',
  '#h-with': 'Copot satu, semuanya rusak',
  '#h-with + .sub': 'Setiap bagian punya satu tugas di Lelang. Pilih satu untuk melihat apa yang rusak tanpanya.',
  '#h-demo': 'Demonya, 185 detik',
  '.vcap': 'Direkam dari halaman live di situs ini; setiap pengecekan di dalamnya berjalan di Kite testnet. <a href="pitch-30s.mp4">Versi 30 detik</a> · <a href="demo.mp4">MP4</a>',
  '#h-didnt': 'Yang tidak berhasil',
  '#h-didnt + .sub': 'Kegagalan kami, lengkap dengan angkanya. Masing-masing mengubah kode.',
  '#fan article:nth-child(1) h3': 'Kami menyita penawaran yang jujur',
  '#fan article:nth-child(1) p': 'Di tender #10 pengecekan mengutip paragraf "Definitions" berisi dua harga yang tidak ditujukan ke AI mana pun. Panel banding tidak mengonfirmasi, seorang approver menandatangani pembatalan, dan jaminannya <a href="https://testnet.kitescan.ai/tx/0xc06dbeac8b31a1d3d001b9a54ed7530a55a76763a21797585c12e7fb6385f9ed">dikembalikan</a>. Kini setiap slash butuh konfirmasi kedua yang terpisah.',
  '#fan article:nth-child(2) h3': 'Penahanan palsu',
  '#fan article:nth-child(2) p': 'Sebuah penawaran menulis "Delivery: 14 days" dan, di bagian purnajual, "replacement within 3 working days". Pengecekan membaca dua angka pengiriman dan mengirim tender #5 ke manusia. Waktu servis dan perbaikan kini tidak dihitung sebagai pengiriman.',
  '#fan article:nth-child(3) h3': 'Aturan hasil belajar dari Reppo tidak membantu',
  '#fan article:nth-child(3) p': 'Kronos menyaring aturan menulis dari 30 rationale bernilai Reppo; skor naik +0,4 dan rute justru memburuk. Yang membantu: memberi penulis rincian skor hasil hitungan kode (draf pertama 74,8 → 93,0).',
  '#fan article:nth-child(4) h3': 'Multipath, diukur lalu ditinggalkan',
  '#fan article:nth-child(4) p': '16 tender × 3 run di award node. Setiap meleset terjadi di confidence ≥ 0,95, jadi sampling kedua tidak menangkap pilihan salah yang yakin. Gerbang kode yang menangkapnya.',
  '#fan article:nth-child(5) h3': 'Penyerang adaptif menemukan celah',
  '#fan article:nth-child(5) p': 'Dua harga untuk satu syarat, tanpa instruksi ke AI, menang 3 dari 9 percobaan. Kini setiap penawaran dengan dua angka untuk satu syarat masuk ke manusia; 0 dari 8 penawaran asli tertandai.',
  '#fan article:nth-child(6) h3': 'Batasan yang kami tahu',
  '#fan article:nth-child(6) p': 'Belum diaudit profesional, dan kedua approver V4 adalah kunci kami sendiri. <a href="https://github.com/PugarHuda/lelang/blob/HEAD/SECURITY.md">SECURITY.md</a> · <a href="https://github.com/PugarHuda/lelang/blob/HEAD/docs/DETAILS.md">semua pengukuran</a>',
  '.fcols p': 'Lelang: tender publik, dari kata bahasa Indonesia. Dibuat selama SERV Hackathon 02.',
};

const EN = {};
for (const sel of Object.keys(ID)) { const el = document.querySelector(sel); if (el) EN[sel] = el.innerHTML; }

// split a heading's text into word spans for the blur-in; <br> and other elements are kept
function split(h) {
  let i = 0;
  for (const n of [...h.childNodes]) {
    if (n.nodeType !== 3) continue;
    const f = document.createDocumentFragment();
    for (const part of n.textContent.split(/(\s+)/)) {
      if (!part) continue;
      if (/^\s+$/.test(part)) { f.append(part); continue; }
      const w = document.createElement('span'); w.className = 'w'; w.style.setProperty('--i', i++); w.textContent = part; f.append(w);
    }
    n.replaceWith(f);
  }
}

const read = () => { try { return localStorage.getItem('lelang.lang'); } catch { return null; } };
function apply(lang) {
  const t = lang === 'id' ? ID : EN;
  for (const [sel, html] of Object.entries(t)) {
    const el = document.querySelector(sel);
    if (!el) continue;
    el.innerHTML = html;
    if (el.hasAttribute('data-words')) split(el);
  }
  document.documentElement.lang = lang;
  for (const b of document.querySelectorAll('.lang button')) b.setAttribute('aria-pressed', String(b.dataset.lang === lang));
  dispatchEvent(new CustomEvent('langchange', { detail: lang }));
}

const box = document.createElement('div');
box.className = 'lang';
box.setAttribute('role', 'group');
box.setAttribute('aria-label', 'Language / Bahasa');
box.innerHTML = '<button type="button" data-lang="en">EN</button><button type="button" data-lang="id">ID</button>';
box.addEventListener('click', (e) => {
  const lang = e.target.closest('button')?.dataset.lang;
  if (!lang) return;
  try { localStorage.setItem('lelang.lang', lang); } catch {}
  apply(lang);
});
document.body.append(box);

for (const h of document.querySelectorAll('[data-words]')) split(h);
const start = read() ?? (navigator.language?.toLowerCase().startsWith('id') ? 'id' : 'en');
if (start === 'id') apply('id'); else box.querySelector('[data-lang="en"]').setAttribute('aria-pressed', 'true');
