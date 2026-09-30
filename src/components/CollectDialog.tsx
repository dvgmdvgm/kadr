import { useEffect, useState } from 'react'
import { create } from 'zustand'
import type { CollectPlan } from '@shared/projectPaths'
import { Modal } from './Modal'
import { size } from './StoragePanel'
import { useEditor } from '@/state/store'
import { appCommands } from '@/engine/actions'
import { logError } from '@/engine/log'
import { tr, trf, useT } from '../i18n'

/**
 * «Собрать проект» (card H8): every file the project refers to is copied into
 * `<project folder>/media/` and the paths rewritten (one undo step), then the
 * project is saved — paths inside its folder go to disk relative, so the folder
 * alone opens on another machine. The size and the free space come first.
 */
export const useCollectUi = create<{ open: boolean }>(() => ({ open: false }))

/** the menu's «Собрать проект…»: a never-saved project has no folder yet — Save asks where first */
export async function startCollect() {
  if (!useEditor.getState().projectPath && !(await appCommands.save())) return
  useCollectUi.setState({ open: true })
}

type Stage =
  | { kind: 'plan' }
  | { kind: 'ready'; plan: CollectPlan }
  | { kind: 'running'; done: number; total: number; file: string }
  | { kind: 'done'; files: number }
  | { kind: 'error'; message: string }

const nameOf = (p: string) => p.slice(Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')) + 1)

export function CollectDialog() {
  const open = useCollectUi((s) => s.open)
  return open ? <CollectBody /> : null
}

function CollectBody() {
  const t = useT()
  const path = useEditor((s) => s.projectPath)
  const [stage, setStage] = useState<Stage>({ kind: 'plan' })
  const close = () => useCollectUi.setState({ open: false })

  useEffect(() => {
    if (!path) return
    window.kadr.collectPlan(useEditor.getState().project, path)
      .then((plan) => setStage({ kind: 'ready', plan }), (err) => setStage({ kind: 'error', message: String(err) }))
  }, [path])
  useEffect(() => window.kadr.onCollectProgress((p) => setStage({ kind: 'running', ...p })), [])

  const run = async (plan: CollectPlan) => {
    if (!path) return
    setStage({ kind: 'running', done: 0, total: plan.copyBytes, file: '' })
    try {
      const map = await window.kadr.collectRun(useEditor.getState().project, path)
      useEditor.getState().relocatePaths(map)
      // a failed save flashes its own error in the top bar; the paths stay rewritten (undo reverts them)
      if (await appCommands.save()) setStage({ kind: 'done', files: Object.keys(map).length })
      else setStage({ kind: 'error', message: t('saveError') })
    } catch (err) {
      const message = String(err).includes('cancelled') ? t('collectCancelled') : String(err)
      if (!String(err).includes('cancelled')) logError(tr('collectTitle'), message, err)
      setStage({ kind: 'error', message })
    }
  }

  const count = (plan: CollectPlan, a: string) => plan.items.filter((i) => i.action === a).length
  const running = stage.kind === 'running'
  let body: React.ReactNode = <p>{t('collectPlanning')}</p>
  let primary: React.ReactNode = null
  if (stage.kind === 'ready') {
    const { plan } = stage
    const copy = count(plan, 'copy'), reuse = count(plan, 'reuse'), missing = count(plan, 'missing')
    const short = plan.free !== null && plan.copyBytes > plan.free
    body = (
      <>
        <p>{t('collectAbout')}</p>
        <div data-act="collect-facts">
          <p>{t('collectCopy')}: <b>{copy}</b> · {size(plan.copyBytes, t)}</p>
          {reuse > 0 && <p>{t('collectReuse')}: <b>{reuse}</b></p>}
          <p>{t('collectInside')}: <b>{count(plan, 'inside')}</b></p>
          {missing > 0 && <p>{t('collectMissing')}: <b>{missing}</b></p>}
          <p>{t('collectFree')}: {plan.free === null ? '—' : size(plan.free, t)}</p>
        </div>
        {short && <p className="set-error" role="alert">{t('collectNoSpace')}</p>}
        {copy + reuse === 0 && <p>{t('collectNothing')}</p>}
      </>
    )
    if (copy + reuse > 0) {
      primary = <button className="primary" data-act="collect-run" disabled={short} onClick={() => void run(plan)}>{t('collectRun')}</button>
    }
  } else if (stage.kind === 'running') {
    body = (
      <div className="export-progress">
        <div>{stage.file ? nameOf(stage.file) : t('collectPlanning')} · {size(stage.done, t)} / {size(stage.total, t)}</div>
        <progress value={stage.total ? stage.done / stage.total : 0} max={1} />
      </div>
    )
  } else if (stage.kind === 'done') {
    body = <p data-act="collect-done">{trf('collectDone', { n: stage.files })}</p>
  } else if (stage.kind === 'error') {
    body = <p className="set-error" role="alert" data-act="collect-error">{stage.message}</p>
  }

  return (
    <Modal
      title={t('collectTitle')}
      onClose={() => { if (!running) close() }}
      actions={running
        ? <button data-act="collect-cancel" onClick={() => void window.kadr.collectCancel()}>{t('cancel')}</button>
        : <>
            <button data-act="collect-close" onClick={close}>{t(stage.kind === 'done' ? 'close' : 'cancel')}</button>
            {primary}
          </>}
    >
      {body}
    </Modal>
  )
}
