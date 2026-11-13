/**
 * util —— 从 index.js 拆出来的模块。
 *
 * 只做搬家，逻辑未改：每个函数的行为与拆分前逐字一致。
 */
import path from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'

import { DATA_DIR } from './config.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const errText = (error) => String((error && error.message) || error || '未知错误')


// 工具返回值必须是无损 JSON：undefined 会让整次调用被判 invalid。
const lossless = (value) => JSON.parse(JSON.stringify(value ?? null))


function todayKey() {
  try {
    return new Date().toLocaleDateString('sv-SE')
  } catch {
    return new Date().toISOString().slice(0, 10)
  }
}


const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/* ------------------------------------------------- 逛论坛的留痕与内容提取 */


async function readJson(file, fallback) {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : { ...fallback }
  } catch {
    return { ...fallback }
  }
}


async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(value, null, 2), 'utf8')
}


/** 把注册失败之类的问题落到文件里——异常被 ctx.effect 吞掉时，这是唯一能看见的地方。 */
async function noteDiag(what, detail) {
  try {
    await mkdir(DATA_DIR, { recursive: true })
    const line = `${new Date().toISOString()} [${what}] ${detail}\n`
    await writeFile(path.join(DATA_DIR, 'diag.log'), line, { encoding: 'utf8', flag: 'a' })
  } catch {
    /* 诊断本身失败就算了，不能影响主流程 */
  }
}


function formatTime(date) {
  try {
    return new Date(date).toLocaleString('zh-CN', {
      timeZone: 'Asia/Shanghai',
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
  } catch {
    return new Date(date).toISOString()
  }
}


export { sleep, errText, lossless, todayKey, escapeRegExp, readJson, writeJson, noteDiag, formatTime }
