import type { FeatureFlags, Settings } from '../domain/schemas';
import { SettingsSchema } from '../domain/schemas';
import type { Money } from '../domain/money';
import type { AppDatabase } from '../storage/db';
import { hashPin, verifyPin } from './pin';

/**
 * PRD Section 6: limits and tiers change only here, behind the app PIN.
 *
 * There is deliberately no registry entry for a settings action, so no
 * proposal, no chat message and no tool call can reach this code path. The only
 * caller is the settings screen.
 */
export interface SettingsPatch {
  perActionCap?: Money;
  dailyCap?: Money;
  staleDataHours?: number;
  featureFlags?: Partial<FeatureFlags>;
}

export type SettingsUpdateResult = { ok: true; settings: Settings } | { ok: false; reason: string };

export interface SettingsService {
  get(): Promise<Settings>;
  update(patch: SettingsPatch, pin: string): Promise<SettingsUpdateResult>;
  changePin(currentPin: string, newPin: string): Promise<SettingsUpdateResult>;
}

export function createSettingsService(db: AppDatabase): SettingsService {
  async function read(): Promise<Settings> {
    const settings = await db.settings.get('app');
    if (!settings) throw new Error('settings are not initialised; load the seed data first');
    return settings;
  }

  return {
    get: read,

    update: async (patch, pin) => {
      const current = await read();
      if (!(await verifyPin(pin, current.pinHash))) {
        return { ok: false, reason: 'wrong PIN' };
      }

      const candidate = SettingsSchema.safeParse({
        ...current,
        ...(patch.perActionCap === undefined ? {} : { perActionCap: patch.perActionCap }),
        ...(patch.dailyCap === undefined ? {} : { dailyCap: patch.dailyCap }),
        ...(patch.staleDataHours === undefined ? {} : { staleDataHours: patch.staleDataHours }),
        featureFlags: { ...current.featureFlags, ...(patch.featureFlags ?? {}) },
        id: current.id,
        pinHash: current.pinHash,
      });

      if (!candidate.success) {
        return { ok: false, reason: candidate.error.issues.map((issue) => issue.message).join('; ') };
      }

      await db.settings.put(candidate.data);
      return { ok: true, settings: candidate.data };
    },

    changePin: async (currentPin, newPin) => {
      const current = await read();
      if (!(await verifyPin(currentPin, current.pinHash))) {
        return { ok: false, reason: 'wrong PIN' };
      }
      if (!/^\d{4,12}$/.test(newPin)) {
        return { ok: false, reason: 'the PIN must be 4 to 12 digits' };
      }
      const updated = SettingsSchema.parse({ ...current, pinHash: await hashPin(newPin) });
      await db.settings.put(updated);
      return { ok: true, settings: updated };
    },
  };
}
