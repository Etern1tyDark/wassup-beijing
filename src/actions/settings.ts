import type { FeatureFlags, Settings } from '../domain/schemas';
import { SettingsSchema } from '../domain/schemas';
import type { Money } from '../domain/money';
import type { AuditLog } from '../audit/log';
import type { AppDatabase } from '../storage/db';
import { hashPin, pinGuardFor } from './pin';

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

/**
 * Upper bounds even the PIN holder cannot pass: a cap of Rp 1e15 or a
 * staleness window of a billion hours would quietly switch a control off.
 */
export const SETTINGS_BOUNDS = {
  maxCap: 100_000_000,
  minStaleDataHours: 1,
  maxStaleDataHours: 168,
} as const;

function outOfBounds(patch: SettingsPatch): string | null {
  for (const field of ['perActionCap', 'dailyCap'] as const) {
    const value = patch[field];
    if (value !== undefined && value > SETTINGS_BOUNDS.maxCap) {
      return `${field} may be at most Rp 100.000.000`;
    }
  }
  const hours = patch.staleDataHours;
  if (
    hours !== undefined &&
    (hours < SETTINGS_BOUNDS.minStaleDataHours || hours > SETTINGS_BOUNDS.maxStaleDataHours)
  ) {
    return 'staleDataHours must be between 1 and 168 (one week)';
  }
  return null;
}

export type SettingsUpdateResult = { ok: true; settings: Settings } | { ok: false; reason: string };

export interface SettingsService {
  get(): Promise<Settings>;
  update(patch: SettingsPatch, pin: string): Promise<SettingsUpdateResult>;
  changePin(currentPin: string, newPin: string): Promise<SettingsUpdateResult>;
}

/**
 * Every change and every wrong PIN is written to the audit log: raising a limit
 * or switching on simulated transfers is exactly what an attacker would want,
 * so it must be as visible as an approval. The entries have no proposal, which
 * keeps them out of reach of undo.
 */
export function createSettingsService(db: AppDatabase, audit?: AuditLog): SettingsService {
  const guard = pinGuardFor(db);

  async function read(): Promise<Settings> {
    const settings = await db.settings.get('app');
    if (!settings) throw new Error('settings are not initialised; load the seed data first');
    return settings;
  }

  async function checkPin(pin: string, stored: string, what: string): Promise<string | null> {
    const result = await guard.check(pin, stored);
    if (result.ok) return null;
    await audit?.append({
      actor: 'user',
      event: 'refused',
      action: 'settings.update',
      proposalId: null,
      detail: `${what} refused: ${result.reason} (${result.failures} in a row)`,
      payload: { reason: 'pin', failures: result.failures, locked: result.locked },
    });
    return result.reason;
  }

  function changed(before: Settings, after: Settings): string[] {
    const fields: string[] = [];
    if (before.perActionCap !== after.perActionCap) fields.push(`perActionCap ${before.perActionCap} -> ${after.perActionCap}`); // prettier-ignore
    if (before.dailyCap !== after.dailyCap) fields.push(`dailyCap ${before.dailyCap} -> ${after.dailyCap}`);
    if (before.staleDataHours !== after.staleDataHours) fields.push(`staleDataHours ${before.staleDataHours} -> ${after.staleDataHours}`); // prettier-ignore
    for (const [flag, value] of Object.entries(after.featureFlags)) {
      const previous = (before.featureFlags as Record<string, unknown>)[flag];
      if (previous !== value) fields.push(`${flag} ${String(previous)} -> ${String(value)}`);
    }
    return fields;
  }

  return {
    get: read,

    update: async (patch, pin) => {
      const current = await read();
      const refused = await checkPin(pin, current.pinHash, 'settings change');
      if (refused) return { ok: false, reason: refused };

      const outOfRange = outOfBounds(patch);
      if (outOfRange) return { ok: false, reason: outOfRange };

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
      const fields = changed(current, candidate.data);
      if (fields.length > 0) {
        await audit?.append({
          actor: 'user',
          event: 'executed',
          action: 'settings.update',
          proposalId: null,
          detail: `settings changed behind the PIN: ${fields.join('; ')}`,
          payload: { changed: fields },
        });
      }
      return { ok: true, settings: candidate.data };
    },

    changePin: async (currentPin, newPin) => {
      const current = await read();
      const refused = await checkPin(currentPin, current.pinHash, 'PIN change');
      if (refused) return { ok: false, reason: refused };
      if (!/^\d{4,12}$/.test(newPin)) {
        return { ok: false, reason: 'the PIN must be 4 to 12 digits' };
      }
      const updated = SettingsSchema.parse({ ...current, pinHash: await hashPin(newPin) });
      await db.settings.put(updated);
      await audit?.append({
        actor: 'user',
        event: 'executed',
        action: 'settings.update',
        proposalId: null,
        detail: 'app PIN changed',
        payload: { changed: ['pin'] },
      });
      return { ok: true, settings: updated };
    },
  };
}
