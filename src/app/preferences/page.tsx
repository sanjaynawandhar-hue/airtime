import { Footer, Header } from "@/components/Shell";
import { PreferencesForm } from "@/components/PreferencesForm";
import { readPrefs } from "@/lib/prefs/server";
import { SUPPORTED_COUNTRIES } from "@/lib/prefs/types";
import { WATCH_PROVIDERS, INDIAN_LANGUAGES } from "@/lib/core/config";
import { GENRES } from "@/lib/boards/music";

export const metadata = { title: "Preferences & privacy" };

const LANGUAGE_NAMES: Record<string, string> = {
  hi: "Hindi",
  ta: "Tamil",
  te: "Telugu",
  ml: "Malayalam",
  kn: "Kannada",
  bn: "Bengali",
  mr: "Marathi",
  en: "English",
};

export default async function PreferencesPage() {
  const { prefs, consent } = await readPrefs();

  return (
    <>
      <Header country={prefs.country} />
      <main id="main" className="mx-auto max-w-3xl px-[var(--board-gutter)] pt-6">
        <p className="eyebrow mb-2 text-gold">Yours</p>
        <h1 className="display mb-6 text-3xl text-paper sm:text-4xl">
          Preferences &amp; privacy
        </h1>

        <PreferencesForm
          initial={prefs}
          consent={consent}
          countries={SUPPORTED_COUNTRIES.map((c) => ({ value: c.code, label: c.name }))}
          languages={[...INDIAN_LANGUAGES, "en"].map((code) => ({
            value: code,
            label: LANGUAGE_NAMES[code] ?? code.toUpperCase(),
          }))}
          genres={GENRES.map((g) => ({ value: g.slug, label: g.label }))}
          services={WATCH_PROVIDERS.map((p) => ({ value: p.platform, label: p.name }))}
        />

        <section className="mt-12 border-t border-surface-hi pt-6">
          <h2 className="display mb-2 text-lg text-paper">What we never collect</h2>
          <ul className="flex max-w-prose list-disc flex-col gap-1.5 pl-5 text-sm leading-relaxed text-muted">
            <li>No email address, name, phone number or account of any kind.</li>
            <li>
              No third-party trackers or advertising identifiers. The only cookies
              are ours and there are two of them.
            </li>
            <li>
              Your IP address is never stored. It is hashed with a salt purely to
              rate-limit review posting, and those rows are deleted after 24 hours.
            </li>
            <li>
              No email or push reminders — that would mean holding contact details.
              Release reminders are a calendar file you download instead.
            </li>
          </ul>
        </section>
      </main>
      <Footer />
    </>
  );
}
