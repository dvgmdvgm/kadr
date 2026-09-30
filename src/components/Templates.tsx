import { useEffect, useState } from 'react'
import { create } from 'zustand'
import type { Project } from '@shared/types'
import { projectFromTemplate, templateFileName } from '@shared/template'
import { fpsLabel } from '@shared/projectFormat'
import { CtxMenu } from './CtxMenu'
import { Modal } from './Modal'
import { Icon } from './icons'
import { startCollect } from './CollectDialog'
import { useT, type TKey } from '../i18n'
import { newProject, sanitizeProject, useEditor } from '@/state/store'

type Tpl = { name: string; project: Project }

/** «Новый проект» with templates on disk opens the picker (card H3); null = closed */
export const useTemplatePick = create<{ list: Tpl[] | null }>(() => ({ list: null }))

const meta = (p: Project, t: (k: TKey) => string) => {
  const v = p.tracks.filter((x) => x.kind === 'video').length
  return `${p.width} × ${p.height} · ${fpsLabel(p.fps)} fps · ${t('tplTracks')} ${v} + ${p.tracks.length - v}`
}

/** The picker: the empty default first (focused — Enter keeps today's behaviour), then the templates. */
export function TemplatePicker({ onPick }: { onPick(p: Project): void }) {
  const t = useT()
  const list = useTemplatePick((s) => s.list)
  if (!list) return null
  const close = () => useTemplatePick.setState({ list: null })
  const pick = (make: () => Project) => { close(); onPick(make()) }
  const empty = newProject()
  return (
    <Modal title={t('newProject')} onClose={close} actions={<button onClick={close}>{t('cancel')}</button>}>
      <div className="tpl-list">
        <div className="recent-row">
          <button data-act="tpl-empty" onClick={() => pick(newProject)}>
            <span className="recent-name">{t('tplEmpty')}</span>
            <span className="recent-meta">{meta(empty, t)}</span>
          </button>
        </div>
        {list.map((x) => (
          <div className="recent-row" key={x.name}>
            <button data-act="tpl-pick" onClick={() => pick(() => projectFromTemplate(sanitizeProject(x.project)))}>
              <span className="recent-name">{x.name}</span>
              <span className="recent-meta">{meta(x.project, t)}</span>
            </button>
          </div>
        ))}
      </div>
    </Modal>
  )
}

/** the ▾ half of «Сохранить как…»: a name and «Сохранить», like the pose/fx preset rows */
export function TemplateMenuButton({ onSaved }: { onSaved(name: string | null, err?: unknown): void }) {
  const t = useT()
  const [at, setAt] = useState<{ x: number; y: number } | null>(null)
  const [name, setName] = useState('')
  const [taken, setTaken] = useState<ReadonlySet<string>>(new Set())
  useEffect(() => {
    if (!at) return
    const off = () => setAt(null)
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') off() }
    window.addEventListener('pointerdown', off)
    window.addEventListener('keydown', esc)
    void window.kadr.listTemplates().then((l) => setTaken(new Set(l.map((x) => x.name))), () => {})
    return () => {
      window.removeEventListener('pointerdown', off)
      window.removeEventListener('keydown', esc)
    }
  }, [at])
  const save = () => {
    if (!name.trim()) return
    setAt(null)
    window.kadr.saveTemplate(name, useEditor.getState().project).then((n) => onSaved(n), (err) => onSaved(null, err))
  }
  return (
    <>
      <button
        className="split-more"
        data-act="save-template-menu"
        title={t('tplSaveAs')}
        aria-label={t('tplSaveAs')}
        aria-haspopup="menu"
        aria-expanded={!!at}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          if (at) return setAt(null)
          const r = e.currentTarget.getBoundingClientRect()
          setName(useEditor.getState().project.name)
          setAt({ x: r.left, y: r.bottom + 4 })
        }}
      >
        <Icon name="chevronDown" size={13} />
      </button>
      {at && (
        <CtxMenu x={at.x} y={at.y}>
          <div className="ctx-title">{t('tplSaveAs')}</div>
          <div className="recent-none">{t('tplSaveHint')}</div>
          <div className="preset-save-row">
            <input
              autoFocus
              data-act="tpl-name"
              value={name}
              placeholder={t('tplName')}
              aria-label={t('tplName')}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') save() }}
            />
            <button data-act="tpl-save" disabled={!name.trim()} onClick={save}>
              {t(taken.has(templateFileName(name)) ? 'tplReplace' : 'tplSave')}
            </button>
          </div>
          <button data-act="collect-open" title={t('collectMenuHint')} onClick={() => { setAt(null); void startCollect() }}>
            {t('collectMenu')}
          </button>
        </CtxMenu>
      )}
    </>
  )
}
