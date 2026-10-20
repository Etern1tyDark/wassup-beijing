import { createContext, useContext } from 'react';

/**
 * Interface strings in English and Bahasa Indonesia (PRD Section 7, stretch).
 *
 * This covers the fixed labels of the page: headings, the main figures, the
 * buttons and the consent text. The agent's replies, the guardrail texts and
 * the audit log stay in English, the submission language, so that what is
 * logged is the same whichever language is on screen.
 */
export type Language = 'en' | 'id';

const STRINGS = {
  'app.title': {
    en: 'Stonks · permissioned personal-finance agent',
    id: 'Stonks · agen keuangan pribadi berizin',
  },
  'app.tagline': {
    en: 'Local-first demo · every action needs approval · every action is logged · no real money moves',
    id: 'Demo lokal · setiap aksi butuh persetujuan · setiap aksi dicatat · tidak ada uang sungguhan yang berpindah',
  },
  'app.loadSeed': { en: 'Load seed data', id: 'Muat data contoh' },
  'app.resetSeed': { en: 'Reset to seed data', id: 'Kembalikan ke data contoh' },
  'app.emptyTitle': { en: 'No ledger yet', id: 'Belum ada buku kas' },
  'app.emptyBody': {
    en: 'Load the seeded data for the demo persona to see balances, runway, policy coverage and the audit log.',
    id: 'Muat data contoh untuk persona demo agar saldo, daya tahan kas, cakupan polis dan log audit tampil.',
  },
  'app.language': { en: 'Bahasa Indonesia', id: 'English' },
  'app.brand': { en: 'Stonks', id: 'Stonks' },
  'app.brandSub': { en: 'Permissioned finance agent', id: 'Agen keuangan berizin' },
  'app.asOf': { en: 'As of', id: 'Per' },
  'app.localFirst': { en: 'Ledger stays on this device', id: 'Buku kas tetap di perangkat ini' },
  'app.noRealMoney': { en: 'No real money moves', id: 'Tidak ada uang sungguhan yang berpindah' },
  'app.themeDark': { en: 'Switch to dark theme', id: 'Ganti ke tema gelap' },
  'app.themeLight': { en: 'Switch to light theme', id: 'Ganti ke tema terang' },

  'nav.label': { en: 'Sections', id: 'Bagian' },
  'nav.overview': { en: 'Overview', id: 'Ringkasan' },
  'nav.assistant': { en: 'Assistant', id: 'Asisten' },
  'nav.coverage': { en: 'Insurance', id: 'Asuransi' },
  'nav.money': { en: 'Cash moves', id: 'Arus kas' },
  'nav.trust': { en: 'Trust & control', id: 'Kepercayaan & kendali' },

  'section.overviewSub': {
    en: 'What you can spend, how long it lasts, and where it sits.',
    id: 'Berapa yang bisa dibelanjakan, berapa lama bertahan, dan di mana disimpan.',
  },
  'section.assistantSub': {
    en: 'The agent proposes. Nothing changes until you approve the card.',
    id: 'Agen mengusulkan. Tidak ada yang berubah sampai Anda menyetujui kartunya.',
  },
  'section.coverageSub': {
    en: 'What a policy pays, read clause by clause, with the source quoted.',
    id: 'Apa yang dibayar polis, dibaca per klausul, dengan sumber dikutip.',
  },
  'section.moneySub': {
    en: 'Bring in a statement and set money aside. Both go through approval.',
    id: 'Impor mutasi dan sisihkan dana. Keduanya melalui persetujuan.',
  },
  'section.trustSub': {
    en: 'Every action in a hash-chained log, every outbound request in the open.',
    id: 'Setiap aksi di log berantai hash, setiap permintaan keluar terlihat.',
  },

  'landing.cta': { en: 'Load the demo data', id: 'Muat data contoh' },
  'landing.ctaNote': {
    en: 'Synthetic data for the persona Rina. No account, no API key, no network.',
    id: 'Data sintetis untuk persona Rina. Tanpa akun, tanpa kunci API, tanpa jaringan.',
  },

  'home.navFeatures': { en: 'Features', id: 'Fitur' },
  'home.navHow': { en: 'How it works', id: 'Cara kerja' },
  'home.navSecurity': { en: 'Security', id: 'Keamanan' },
  'home.launch': { en: 'Launch demo', id: 'Buka demo' },
  'home.openDashboard': { en: 'Open your dashboard', id: 'Buka dasbor Anda' },
  'home.badge': {
    en: 'FinTechathon 2026 · AI as a financial participant',
    id: 'FinTechathon 2026 · AI sebagai pelaku keuangan',
  },
  'home.titleLead': { en: 'The money agent that', id: 'Agen keuangan yang' },
  'home.titleAccent': { en: 'asks before it acts.', id: 'bertanya sebelum bertindak.' },
  'home.lede': {
    en: 'Stonks forecasts your runway, reads your insurance policy clause by clause and proposes changes you approve with one press. Every action is logged, reversible and stays on your device.',
    id: 'Stonks memproyeksikan daya tahan kas Anda, membaca polis asuransi per klausul dan mengusulkan perubahan yang Anda setujui dengan satu tekan. Setiap aksi tercatat, bisa dibatalkan, dan tetap di perangkat Anda.',
  },
  'home.ctaSecondary': { en: 'See how it works', id: 'Lihat cara kerjanya' },
  'home.trust1': { en: 'No account', id: 'Tanpa akun' },
  'home.trust2': { en: 'No API key', id: 'Tanpa kunci API' },
  'home.trust3': {
    en: 'Your ledger never leaves the browser',
    id: 'Buku kas tidak pernah keluar dari peramban',
  },
  'home.previewLabel': {
    en: 'Preview of an approval card in the demo',
    id: 'Pratinjau kartu persetujuan di demo',
  },
  'home.previewChain': { en: 'Audit chain verified', id: 'Rantai audit terverifikasi' },
  'home.days': { en: 'days', id: 'hari' },

  'home.stat1': { en: 'acceptance checks pass', id: 'pemeriksaan penerimaan lolos' },
  'home.stat2': { en: 'judged attack tests blocked', id: 'uji serangan yang dinilai diblokir' },
  'home.stat3': { en: 'ledger rows sent to the model', id: 'baris buku kas dikirim ke model' },
  'home.stat4': { en: 'actions for the whole golden path', id: 'aksi untuk seluruh alur utama' },

  'home.featuresTitle': {
    en: 'Everything a careful money agent needs',
    id: 'Semua yang dibutuhkan agen keuangan yang hati-hati',
  },
  'home.featuresSub': {
    en: 'Built for freelancers with irregular income: late clients, a policy nobody has read, and no room for surprises.',
    id: 'Dibuat untuk pekerja lepas berpenghasilan tidak tetap: klien yang telat bayar, polis yang belum dibaca, dan tanpa ruang untuk kejutan.',
  },
  'home.f1Title': { en: 'A runway you can trust', id: 'Daya tahan kas yang bisa dipercaya' },
  'home.f1Body': {
    en: 'A 90-day forecast in whole rupiah. Overdue invoices are never counted as income, and every figure shows its inputs.',
    id: 'Proyeksi 90 hari dalam rupiah utuh. Tagihan yang telat tidak pernah dihitung sebagai pemasukan, dan setiap angka menunjukkan inputnya.',
  },
  'home.f2Title': { en: 'Your policy, read for you', id: 'Polis Anda, dibacakan untuk Anda' },
  'home.f2Body': {
    en: 'Limits, co-payments and waiting periods pulled from the PDF in your browser, each with its page and clause.',
    id: 'Batas, biaya bersama dan masa tunggu diambil dari PDF di peramban Anda, masing-masing dengan halaman dan klausulnya.',
  },
  'home.f3Title': { en: 'Every change is a card', id: 'Setiap perubahan adalah kartu' },
  'home.f3Body': {
    en: 'The agent proposes. You see the exact before and after, the guardrails it passed and when it expires, then you approve.',
    id: 'Agen mengusulkan. Anda melihat sebelum dan sesudahnya, pagar pengaman yang dilewati dan masa berlakunya, lalu Anda menyetujui.',
  },
  'home.f4Title': { en: 'Undo anything', id: 'Batalkan apa saja' },
  'home.f4Body': {
    en: 'Every ledger change can be reversed under the same limits, and the original entry stays in the log.',
    id: 'Setiap perubahan buku kas bisa dibatalkan dengan batas yang sama, dan entri aslinya tetap ada di log.',
  },
  'home.f5Title': { en: 'See every byte that leaves', id: 'Lihat setiap bit yang keluar' },
  'home.f5Body': {
    en: 'Names, NIK, phone and account numbers are removed before any request, and the Privacy panel shows the exact payload.',
    id: 'Nama, NIK, nomor telepon dan rekening dihapus sebelum permintaan apa pun, dan panel Privasi menampilkan isinya persis.',
  },
  'home.f6Title': { en: 'Tamper-evident history', id: 'Riwayat anti-rusak' },
  'home.f6Body': {
    en: 'A SHA-256 hash chain of every proposal, approval, refusal and undo, exportable and verifiable offline.',
    id: 'Rantai hash SHA-256 dari setiap usulan, persetujuan, penolakan dan pembatalan, bisa diekspor dan diverifikasi luring.',
  },

  'home.howTitle': {
    en: 'From a question to an approved action in three steps',
    id: 'Dari pertanyaan ke aksi yang disetujui dalam tiga langkah',
  },
  'home.step1Title': { en: 'Ask', id: 'Tanya' },
  'home.step1Body': {
    en: '“Set aside money for medical costs.” The agent reads your ledger and policy through read-only tools.',
    id: '“Sisihkan uang untuk biaya medis.” Agen membaca buku kas dan polis Anda melalui alat baca-saja.',
  },
  'home.step2Title': { en: 'Review', id: 'Tinjau' },
  'home.step2Body': {
    en: 'A card shows what would change (safe to spend, free cash, runway) and every guardrail it passed.',
    id: 'Kartu menampilkan apa yang akan berubah (aman dibelanjakan, kas bebas, daya tahan kas) dan setiap pagar pengaman yang dilewati.',
  },
  'home.step3Title': { en: 'Approve', id: 'Setujui' },
  'home.step3Body': {
    en: 'One press runs it through the only ledger writer. It is logged, and one more press undoes it.',
    id: 'Satu tekan menjalankannya lewat satu-satunya penulis buku kas. Tercatat, dan satu tekan lagi membatalkannya.',
  },

  'home.secEyebrow': { en: 'Security by construction', id: 'Aman sejak rancangan' },
  'home.secTitle': {
    en: 'Security lives in code, not in the prompt',
    id: 'Keamanan ada di kode, bukan di prompt',
  },
  'home.secBody': {
    en: 'The model can only read and propose. A fixed registry decides the tier of every action, guardrails run twice, and approvals use one-time tokens bound to the exact proposal.',
    id: 'Model hanya bisa membaca dan mengusulkan. Registri tetap menentukan tingkat setiap aksi, pagar pengaman berjalan dua kali, dan persetujuan memakai token sekali pakai yang terikat pada usulan itu.',
  },
  'home.sec1': {
    en: 'Hidden instructions in PDFs, CSVs and pasted text are flagged and can never set an amount or an account.',
    id: 'Instruksi tersembunyi di PDF, CSV dan teks tempelan ditandai dan tidak pernah bisa menentukan jumlah atau rekening.',
  },
  'home.sec2': {
    en: 'Every number in a reply must come from a tool result, or the reply is withheld.',
    id: 'Setiap angka dalam balasan harus berasal dari hasil alat, atau balasan ditahan.',
  },
  'home.sec3': {
    en: 'Moving money is refused. A simulation exists only behind a PIN, between your own accounts.',
    id: 'Memindahkan uang ditolak. Simulasi hanya ada di balik PIN, antar rekening Anda sendiri.',
  },
  'home.sec4': {
    en: 'Tested against a deliberately compromised model: it still cannot act.',
    id: 'Diuji melawan model yang sengaja dibobol: tetap tidak bisa bertindak.',
  },
  'home.tiersTitle': { en: 'Four permission tiers', id: 'Empat tingkat izin' },
  'home.tier0': { en: 'Read and explain. Runs freely.', id: 'Membaca dan menjelaskan. Berjalan bebas.' },
  'home.tier1': { en: 'Draft text. Nothing is sent.', id: 'Menyusun teks. Tidak ada yang dikirim.' },
  'home.tier2': {
    en: 'Reversible ledger changes. Needs your Approve.',
    id: 'Perubahan buku kas yang bisa dibatalkan. Butuh persetujuan Anda.',
  },
  'home.tier3': {
    en: 'Money movement. Refused; simulated only, behind a PIN.',
    id: 'Perpindahan uang. Ditolak; hanya simulasi, dengan PIN.',
  },

  'home.ctaTitle': { en: 'See it run on a real month', id: 'Lihat jalannya pada satu bulan nyata' },
  'home.ctaBody': {
    en: 'Explore Rina’s synthetic ledger: a late client, a health policy and a hospital-stay question. No sign-up.',
    id: 'Jelajahi buku kas sintetis Rina: klien yang telat bayar, polis kesehatan dan pertanyaan rawat inap. Tanpa daftar.',
  },
  'home.footer': {
    en: 'Built for FinTechathon 2026 · International Track · All data is synthetic · No real money moves.',
    id: 'Dibuat untuk FinTechathon 2026 · Jalur Internasional · Semua data sintetis · Tidak ada uang sungguhan yang berpindah.',
  },

  'nav.home': { en: 'Home', id: 'Beranda' },
  'app.backHome': { en: 'Back to home', id: 'Kembali ke beranda' },

  'approval.queue': { en: 'Approvals', id: 'Persetujuan' },
  'approval.waiting': { en: 'waiting', id: 'menunggu' },
  'accounts.title': { en: 'Accounts', id: 'Rekening' },

  'balances.title': { en: 'Balances · as of', id: 'Saldo · per' },
  'balances.safeToSpend': { en: 'Safe to spend', id: 'Aman dibelanjakan' },
  'balances.total': { en: 'Total balance', id: 'Total saldo' },
  'balances.freeCash': { en: 'Free cash', id: 'Kas bebas' },
  'balances.obligations': { en: 'Obligations due in 30 days', id: 'Kewajiban jatuh tempo 30 hari' },
  'balances.account': { en: 'Account', id: 'Rekening' },
  'balances.type': { en: 'Type', id: 'Jenis' },
  'balances.balance': { en: 'Balance', id: 'Saldo' },

  'runway.title': { en: 'Runway', id: 'Daya tahan kas' },
  'runway.covered': { en: 'Costs covered for', id: 'Biaya tertutup selama' },
  'runway.months': { en: 'In months', id: 'Dalam bulan' },

  'policy.title': { en: 'Policy coverage', id: 'Cakupan polis' },
  'policy.upload': { en: 'Upload policy PDF', id: 'Unggah PDF polis' },
  'policy.none': { en: 'No policy loaded yet.', id: 'Belum ada polis yang dimuat.' },

  'statement.title': { en: 'Import a statement', id: 'Impor mutasi rekening' },
  'statement.upload': { en: 'Upload statement CSV', id: 'Unggah CSV mutasi' },

  'chat.title': { en: 'Ask the agent', id: 'Tanya agen' },
  'chat.message': { en: 'Your message', id: 'Pesan Anda' },
  'chat.send': { en: 'Send', id: 'Kirim' },
  'chat.new': { en: 'New conversation', id: 'Percakapan baru' },
  'chat.repliesInEnglish': { en: '', id: 'Agen menjawab dalam bahasa Inggris.' },
  'chat.consentAgree': { en: 'I agree, turn chat on', id: 'Saya setuju, aktifkan obrolan' },
  'chat.consentIntro': {
    en: 'Before the first model call, please read this. Your ledger stays in this browser. When you chat, the agent sends the model only your message and the tool results it needs, after names, account and policy numbers, NIK, phone numbers and email addresses are removed. With a hosted model that text is processed outside Indonesia.',
    id: 'Sebelum panggilan model pertama, mohon baca ini. Buku kas Anda tetap di peramban ini. Saat Anda mengobrol, agen hanya mengirim pesan Anda dan hasil alat yang diperlukan ke model, setelah nama, nomor rekening dan polis, NIK, nomor telepon dan alamat email dihapus. Dengan model yang di-hosting, teks itu diproses di luar Indonesia.',
  },
  'chat.consentPanel': {
    en: 'The Privacy panel lists every request and exactly what was in it, and lets you block them. The agent can only propose; nothing changes without your Approve.',
    id: 'Panel Privasi menampilkan setiap permintaan beserta isinya, dan Anda bisa memblokirnya. Agen hanya bisa mengusulkan; tidak ada yang berubah tanpa persetujuan Anda.',
  },

  'approval.needed': { en: 'Approval needed', id: 'Butuh persetujuan' },
  'approval.approve': { en: 'Approve', id: 'Setujui' },
  'approval.reject': { en: 'Reject', id: 'Tolak' },
  'approval.none': {
    en: 'Approvals · no proposals are waiting for approval.',
    id: 'Persetujuan · tidak ada usulan yang menunggu.',
  },

  'earmarks.title': { en: 'Earmarks', id: 'Dana sisihan' },
  'earmarks.propose': { en: 'Propose an earmark', id: 'Usulkan dana sisihan' },
  'earmarks.none': { en: 'Nothing set aside yet.', id: 'Belum ada dana yang disisihkan.' },

  'audit.title': { en: 'Audit log', id: 'Log audit' },
  'audit.undo': { en: 'Undo last action', id: 'Batalkan aksi terakhir' },
  'audit.verify': { en: 'Verify chain', id: 'Verifikasi rantai' },
  'audit.export': { en: 'Export JSON', id: 'Ekspor JSON' },

  'privacy.title': { en: 'Privacy · outbound requests', id: 'Privasi · permintaan keluar' },
  'privacy.block': { en: 'Block outbound requests', id: 'Blokir permintaan keluar' },
  'privacy.empty': { en: 'Nothing has left this browser.', id: 'Belum ada yang keluar dari peramban ini.' },

  'settings.title': { en: 'Settings (PIN required)', id: 'Pengaturan (butuh PIN)' },
} as const;

export type StringKey = keyof typeof STRINGS;
export const STRING_KEYS = Object.keys(STRINGS) as StringKey[];

export function translate(language: Language, key: StringKey): string {
  return STRINGS[key][language];
}

const STORAGE_KEY = 'ui-language';

export function readStoredLanguage(): Language {
  try {
    return globalThis.localStorage?.getItem(STORAGE_KEY) === 'id' ? 'id' : 'en';
  } catch {
    return 'en';
  }
}

export function storeLanguage(language: Language): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, language);
  } catch {
    // Without storage the choice lasts until the page is reloaded.
  }
}

export interface LanguageContextValue {
  language: Language;
  setLanguage: (language: Language) => void;
}

export const LanguageContext = createContext<LanguageContextValue>({
  language: 'en',
  setLanguage: () => undefined,
});

/** `t('chat.send')` in the current language. */
export function useT(): (key: StringKey) => string {
  const { language } = useContext(LanguageContext);
  return (key) => translate(language, key);
}
