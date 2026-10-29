import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { TranslatePipe } from '../../core/i18n';
import type { SourceSubtitleMask, SourceSubtitleMaskMode } from '../../core/models';

/** A manual band when the user switches from auto-detect: the conventional lower band. */
const DEFAULT_MANUAL = { topPct: 80, heightPct: 14 };

/**
 * Picker for hiding the subtitles already burned into the source video.
 *
 * Mode (keep / blur / dark band), then where: auto-detect (the renderer finds
 * the band from the source's speech timing) or a manual band given as a top
 * position and a height, in percent of the frame height. The band always spans
 * the full width — hardsubs are centred and their width changes cue by cue.
 * Emits a whole new {@link SourceSubtitleMask} on every change.
 */
@Component({
  selector: 'vd-source-subtitle-mask',
  standalone: true,
  imports: [TranslatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="mask-picker">
      <label class="mask-row">
        <span class="label">{{ 'mask.mode-label' | translate }}</span>
        <select [value]="mode()" [disabled]="disabled()" (change)="setMode($any($event.target).value)">
          @for (m of modes; track m) {
            <option [value]="m" [selected]="m === mode()">{{ 'mask.modes.' + m | translate }}</option>
          }
        </select>
      </label>
      @if (mode() !== 'off') {
        <label class="mask-row">
          <span class="label">{{ 'mask.region-label' | translate }}</span>
          <select [disabled]="disabled()" (change)="setManual($any($event.target).value === 'manual')">
            <option value="auto" [selected]="!manual()">{{ 'mask.regions.auto' | translate }}</option>
            <option value="manual" [selected]="manual()">{{ 'mask.regions.manual' | translate }}</option>
          </select>
        </label>
        @if (manual()) {
          <label class="mask-row">
            <span class="label">{{ 'mask.top' | translate }}</span>
            <input
              type="number"
              min="0"
              max="99"
              step="1"
              [value]="topPct()"
              [disabled]="disabled()"
              (change)="setBand(+$any($event.target).value, heightPct())"
            />
          </label>
          <label class="mask-row">
            <span class="label">{{ 'mask.height' | translate }}</span>
            <input
              type="number"
              min="1"
              max="100"
              step="1"
              [value]="heightPct()"
              [disabled]="disabled()"
              (change)="setBand(topPct(), +$any($event.target).value)"
            />
          </label>
        }
        <p class="hint">{{ (manual() ? 'mask.hint-manual' : 'mask.hint-auto') | translate }}</p>
      }
    </div>
  `,
  styles: `
    .mask-picker { display: flex; flex-direction: column; gap: 0.4rem; }
    .mask-row { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; }
    .mask-row input[type='number'] { width: 5.5rem; }
    .hint { margin: 0; }
  `,
})
export class SourceSubtitleMaskComponent {
  readonly value = input<SourceSubtitleMask | undefined>();
  readonly disabled = input(false);
  readonly valueChange = output<SourceSubtitleMask>();

  protected readonly modes: readonly SourceSubtitleMaskMode[] = ['off', 'blur', 'box'];
  protected readonly mode = computed<SourceSubtitleMaskMode>(() => this.value()?.mode ?? 'off');
  protected readonly manual = computed(() => this.value()?.region !== undefined);
  protected readonly topPct = computed(() => Math.round((this.value()?.region?.y ?? DEFAULT_MANUAL.topPct / 100) * 100));
  protected readonly heightPct = computed(() =>
    Math.round((this.value()?.region?.height ?? DEFAULT_MANUAL.heightPct / 100) * 100),
  );

  protected setMode(mode: SourceSubtitleMaskMode): void {
    const region = this.value()?.region;
    this.valueChange.emit(region ? { mode, region } : { mode });
  }

  protected setManual(manual: boolean): void {
    if (!manual) {
      this.valueChange.emit({ mode: this.mode() });
      return;
    }
    this.setBand(this.topPct(), this.heightPct());
  }

  /** Clamp to the frame: top in 0..99, height at least 1 and never past the bottom. */
  protected setBand(topPct: number, heightPct: number): void {
    const top = Math.min(99, Math.max(0, Number.isFinite(topPct) ? Math.round(topPct) : DEFAULT_MANUAL.topPct));
    const height = Math.min(100 - top, Math.max(1, Number.isFinite(heightPct) ? Math.round(heightPct) : 1));
    this.valueChange.emit({ mode: this.mode(), region: { x: 0, y: top / 100, width: 1, height: height / 100 } });
  }
}
