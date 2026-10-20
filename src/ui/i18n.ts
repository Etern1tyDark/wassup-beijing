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
  'app.title': { en: 'Permissioned personal-finance agent', id: 'Agen keuangan pribadi berizin' },
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
  'app.brand': { en: 'Wassup Ledger', id: 'Wassup Ledger' },
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

  'landing.eyebrow': { en: 'FinTechathon 2026 · local-first demo', id: 'FinTechathon 2026 · demo lokal' },
  'landing.title': {
    en: 'A finance agent that asks before it acts.',
    id: 'Agen keuangan yang bertanya sebelum bertindak.',
  },
  'landing.cta': { en: 'Explore with demo data', id: 'Jelajahi dengan data contoh' },
  'landing.ctaNote': {
    en: 'Synthetic data for the persona Rina. No account, no API key, no network.',
    id: 'Data sintetis untuk persona Rina. Tanpa akun, tanpa kunci API, tanpa jaringan.',
  },
  'landing.p1Title': { en: 'Stays on your device', id: 'Tetap di perangkat Anda' },
  'landing.p1Body': {
    en: 'The ledger lives in this browser. Only redacted text ever leaves, and you see every byte.',
    id: 'Buku kas ada di peramban ini. Hanya teks yang disamarkan yang keluar, dan Anda melihat setiap bitnya.',
  },
  'landing.p2Title': { en: 'You approve every change', id: 'Anda menyetujui setiap perubahan' },
  'landing.p2Body': {
    en: 'Each action is tiered, checked against guardrails and shown as a before-and-after card.',
    id: 'Setiap aksi diberi tingkat, diperiksa pagar pengaman dan ditampilkan sebagai kartu sebelum-sesudah.',
  },
  'landing.p3Title': { en: 'Logged and reversible', id: 'Tercatat dan bisa dibatalkan' },
  'landing.p3Body': {
    en: 'An append-only, hash-chained audit log you can verify, export and undo from.',
    id: 'Log audit berantai hash yang hanya bisa ditambah, bisa diverifikasi, diekspor dan dibatalkan.',
  },
  'landing.tiersTitle': { en: 'Three permission tiers', id: 'Tiga tingkat izin' },
  'landing.t1': { en: 'Read and explain. Runs freely.', id: 'Membaca dan menjelaskan. Berjalan bebas.' },
  'landing.t2': {
    en: 'Reversible ledger changes. Needs your Approve.',
    id: 'Perubahan buku kas yang bisa dibatalkan. Butuh persetujuan Anda.',
  },
  'landing.t3': {
    en: 'Money movement. Simulated only, behind a PIN.',
    id: 'Perpindahan uang. Hanya simulasi, dengan PIN.',
  },

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
