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
