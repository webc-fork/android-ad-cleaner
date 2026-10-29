#!/usr/bin/env -S bun
// clean.js —— 一键清理所有已连接安卓手机的广告（按 AGENTS.md §3 流程编排 tool/run.py）
//
// 用法：
//   ./clean.js               清理当前连接的所有手机，全程自动执行
//   ./clean.js -s <序列号>   只清理指定的一台
//   ./clean.js --ref         本型号没有机型脚本时，用同品牌参考脚本安全模式试跑
//                            （只关脚本里点名的开关；不加则跳过机型脚本，只跑通用部分）
//
// 每台手机依次执行：备份快照 → 机型脚本 → 关营销通知渠道（自动滤掉服务类）
//   → 挂起广告包 → 关闭快应用 → finish 收尾。跑这个脚本即视为机主同意这些改动，
//   全部可还原（见结尾汇总）。中途 Ctrl-C 会先给当前手机跑 finish 再退出。
import { $ } from "bun";
import { existsSync, readdirSync, statSync } from "node:fs";

process.chdir(import.meta.dirname);
const ROOT = import.meta.dirname;
const BK_ROOT = process.env.AAC_BACKUPS || ROOT + "/backups";
let py = process.env.AAC_PYTHON || "python3";

let ref_mode = false, only_serial = "", cur_serial = "";
const note_li = [], restore_li = [], result_li = [];

// ---------- 工具 ----------
const die = (msg) => { console.error(msg); process.exit(1); };

const adbFind = async () => {
  const which = await $`which adb`.quiet().nothrow();
  const cand_li = [process.env.ADB, which.stdout.toString().trim(), process.env.HOME + "/Library/Android/sdk/platform-tools/adb",
                   process.env.HOME + "/platform-tools/adb", process.env.HOME + "/android-tools/platform-tools/adb"];
  return cand_li.find(c => c && existsSync(c)) || "";
};

const u2Ensure = async () => {
  const u2Have = async () => (await $`${py} -c "import uiautomator2"`.quiet().nothrow()).exitCode === 0;
  if (await u2Have()) return;
  console.log("缺 uiautomator2，正在按 requirements.txt 安装……");
  if ((await $`${py} -m pip install -r requirements.txt`.quiet().nothrow()).exitCode === 0 && await u2Have()) return;
  const venv_py = ROOT + "/.venv/bin/python";
  if ((await $`${py} -m venv ${ROOT}/.venv`.quiet().nothrow()).exitCode === 0
      && (await $`${venv_py} -m pip install -q -r requirements.txt`.quiet().nothrow()).exitCode === 0) {
    py = venv_py;
    console.log("已装到 " + ROOT + "/.venv");
    return;
  }
  console.log("⚠ 自动安装失败，机型脚本和「关通知渠道」会跳过。手动装：pip3 install -r requirements.txt");
};

const deviceList = async (adb) => {
  const out = await $`${adb} devices`.quiet().text();
  const dev_li = [], bad_li = [];
  for (const line of out.split("\n")) {
    if (!line.includes("\t")) continue;
    const [serial, state] = line.split("\t");
    if (state === "device") dev_li.push(serial);
    else bad_li.push([serial, state]);
  }
  return [dev_li, bad_li];
};

const statusLoad = async (serial) => {
  const r = await $`${py} tool/run.py -s ${serial} status-json`.quiet().nothrow();
  if (r.exitCode !== 0) return null;
  const text = r.stdout.toString().trim();
  if (!text.startsWith("{")) return null;
  try { return JSON.parse(text); } catch { return null; }   // status-json 输出可能被截断
};

const unlockWait = (serial) =>
  $`${py} -c 'import sys; sys.path.insert(0, "tool"); import run; sys.exit(0 if run.wait_unlocked(sys.argv[1]) else 1)' ${serial}`.nothrow();

// run.py 子命令：默认实时输出到终端，退出码用 .nothrow() 拿
const stepRun = (serial, ...arg_li) => $`${py} tool/run.py -s ${serial} ${arg_li}`.nothrow();

// ---------- 营销通知渠道（AGENTS.md §5：滤掉服务类，剩下的才是营销） ----------
const SERV_RE = /网络共享|智能热点|红包助手|权限建议|驾驶|盗窃|找机位|机位|直播提醒|天气预警|警告|告警|实时活动|赛事|护眼/;
const VAGUE_RE = /^(其他|普通通知|推送通知|通知|推广通知|推荐通知)$/;

const channelFilter = async (tsv) => {
  const auto_tsv = tsv.replace("channels.tsv", "channels-auto.tsv");
  const keep_li = [], drop_li = [];
  for (const line of (await Bun.file(tsv).text()).split("\n")) {
    if (!line || line.startsWith("#")) { keep_li.push(line); continue; }
    const [, cid, name] = line.split("\t");
    if (SERV_RE.test(cid + " " + name) || VAGUE_RE.test(name || "")) { drop_li.push(name); continue; }
    keep_li.push(line);
  }
  await Bun.write(auto_tsv, keep_li.join("\n") + "\n");
  return [keep_li.filter(l => l && !l.startsWith("#")).length, auto_tsv, drop_li];
};

const tsvNewest = (model) => {
  if (!existsSync(BK_ROOT)) return "";
  const dir_li = readdirSync(BK_ROOT).filter(n => n.startsWith(model + "-")).map(n => BK_ROOT + "/" + n)
    .filter(p => statSync(p).isDirectory()).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  for (const d of dir_li) if (existsSync(d + "/channels.tsv")) return d + "/channels.tsv";
  return "";
};

// chan-off 一跑几分钟：stdout 边收边打印并留档，退出码取 proc.exited
const channelOff = async (serial, tsv) => {
  const log_file = tsv.replace("channels-auto.tsv", "chan-off.log");
  const proc = Bun.spawn([py, "tool/run.py", "-s", serial, "chan-off", tsv], { stdout: "pipe", stderr: "inherit" });
  const part_li = [];
  for await (const chunk of proc.stdout) {
    process.stdout.write(chunk);
    part_li.push(chunk);
  }
  const rc = await proc.exited;
  const out_text = Buffer.concat(part_li).toString();
  await Bun.write(log_file, out_text);
  return [rc, out_text];
};

// ---------- 单台清理 ----------
const cleanOne = async (serial) => {
  cur_serial = "";
  let closed_cnt = 0;
  console.log("\n━━━━━━━━━ 开始处理 " + serial + " ━━━━━━━━━");

  const st = await statusLoad(serial);
  if (!st) {
    note_li.push(serial + "：连不上或读取状态失败");
    result_li.push(serial + " ✗ 状态读取失败");
    return;
  }
  const info = st.info || {};
  const model = info.model || "";
  console.log("机型：" + (info.name || (info.brand || "") + " " + model) + "（" + model + "）");
  if (st.input_blocked)
    console.log("⚠ 小米系未开「USB 调试（安全设置）」：能读屏但点不动。本台跳过读屏类步骤（机型脚本、关渠道），只做挂起广告包 / 关快应用；打开后重跑可清理更全（需插 SIM 卡、登录小米账号）");
  if (st.fold_open) console.log("⚠ 折叠屏是展开状态，定位不准：请合上手机用外屏");
  if (st.locked && (await unlockWait(serial)).exitCode !== 0) {
    note_li.push(serial + "：一直锁屏没解锁，跳过这台；解锁并保持亮屏后重跑");
    result_li.push(serial + " ✗ 锁屏未解锁");
    return;
  }

  if ((await stepRun(serial, "backup")).exitCode !== 0) {
    note_li.push(serial + "：备份失败（读不到包列表），未做任何改动");
    result_li.push(serial + " ✗ 备份失败");
    return;
  }
  cur_serial = serial;   // 备份成功后才可能改动手机；中断收尾从这里开始

  // 机型脚本（点屏幕的步骤；读屏被拒时跳过）
  if (st.input_blocked) {
    note_li.push(serial + "：跳过读屏类步骤（机型脚本、关渠道）——未开「USB 调试（安全设置）」，打开后重跑可清理更全");
  } else if (!st.recipe) {
    console.log("本型号没有机型脚本，只跑通用部分（通知渠道、广告包、快应用）；其余可照 docs/清单 手动做");
    note_li.push(serial + "：无机型脚本，仅跑了通用部分；加 --ref 可用同品牌参考脚本");
  } else if (st.recipe_ok) {
    console.log("跑机型脚本：" + st.recipe + "（版本一致）……");
    if ((await stepRun(serial, "recipe")).exitCode !== 0)
      note_li.push(serial + "：机型脚本部分步骤没找到入口（系统版本和录制版本不同属正常），详见上面输出");
  } else if (st.recipe_ref) {
    if (ref_mode) {
      console.log("用同品牌参考脚本 " + st.recipe + " 安全模式试跑（只关点名的开关）……");
      if ((await stepRun(serial, "recipe", "--ref")).exitCode !== 0)
        note_li.push(serial + "：参考脚本多数步骤没找到，跳过；建议照 docs/清单 手动做");
    } else {
      note_li.push(serial + "：未跑机型脚本（无专属脚本；要试参考脚本请加 --ref）；其余通用部分照常");
    }
  } else {
    console.log("机型脚本 " + st.recipe + " 录制版本和这台不同，自动安全模式跑……");
    if ((await stepRun(serial, "recipe")).exitCode !== 0)
      note_li.push(serial + "：机型脚本部分步骤没找到入口，详见上面输出");
  }

  // 营销通知渠道
  if (!st.input_blocked) {
    if ((await stepRun(serial, "chan-scan")).exitCode !== 0) {
      note_li.push(serial + "：扫营销渠道失败，详见上面输出");
    } else {
      const tsv = tsvNewest(model);
      if (!tsv) note_li.push(serial + "：没找到渠道清单文件");
      else {
        const [cnt, auto_tsv, drop_li] = await channelFilter(tsv);
        drop_li.forEach(n => console.log("  · 跳过服务类渠道：" + n));
        if (cnt === 0) console.log("没有筛出可关的营销通知渠道");
        else {
          console.log("关闭以下 " + cnt + " 个营销通知渠道（已按规范滤掉服务类）：");
          for (const row of (await Bun.file(auto_tsv).text()).split("\n")) {
            if (!row || row.startsWith("#")) continue;
            const [pkg, , name, label] = row.split("\t");
            console.log("  · " + name + "（" + pkg + "）" + (label ? "—— " + label : ""));
          }
          const [rc, out_text] = await channelOff(serial, auto_tsv);
          closed_cnt = parseInt((out_text.match(/拨了 (\d+) 个/) || [])[1] || "0", 10);
          const still_cnt = parseInt((out_text.match(/营销渠道仍开着: (\d+) 个/) || [])[1] || "0", 10);
          restore_li.push(serial + "：还原渠道 → run.py -s " + serial + " chan-on " + auto_tsv);
          if (rc !== 0)
            note_li.push(serial + "：关渠道没全部成功" + (still_cnt ? "，仍开着 " + still_cnt + " 个" : "") + "（系统灰锁 / 页面没认出等），详见上面输出");
        }
      }
    }
  }

  // 广告包 + 快应用（纯 pm 操作，读屏被拒也能做）
  const ad_li = (st.ads || []).filter(a => !a.suspended).map(a => a.pkg);
  const qa_li = (st.quickapps || []).filter(q => !q.closed);
  if (ad_li.length || qa_li.length) {
    if (ad_li.length) console.log("挂起广告包：" + ad_li.join(" "));
    if (qa_li.length) {
      console.log("关闭快应用：");
      qa_li.forEach(q => console.log("  · " + q.name + "（" + q.pkg + "）" + (q.used ? "近期打开过 " + q.used + " 次" : "近期没打开过")));
    }
    if (ad_li.length) {
      if ((await stepRun(serial, "suspend", ...ad_li)).exitCode !== 0)
        note_li.push(serial + "：有广告包挂起失败，详见上面输出");
      restore_li.push(serial + "：还原挂起 → run.py -s " + serial + " unsuspend");
    }
    if (qa_li.length) {
      if ((await stepRun(serial, "quickapp", "off")).exitCode !== 0)
        note_li.push(serial + "：有快应用组件关闭失败（可改在手机上逐个关它的通知），详见上面输出");
      restore_li.push(serial + "：还原快应用 → run.py -s " + serial + " quickapp on");
    }
  } else {
    console.log("广告包和快应用：没有需要处理的（已挂起 / 未安装 / 已关闭）");
  }

  if ((await stepRun(serial, "finish")).exitCode !== 0)
    note_li.push(serial + "：收尾失败，请手动核对插电常亮");
  cur_serial = "";
  const chan_txt = st.input_blocked ? "渠道跳过（读屏被拒）" : "渠道拨了 " + closed_cnt + " 个";
  result_li.push(serial + " ✓ 完成（" + chan_txt + "，广告包 " + ad_li.length + " 个，快应用 " + qa_li.length + " 个）");
};

// ---------- 中断收尾：备份成功后中断，先给当前手机跑 finish 再退出 ----------
let exiting = false;
const onQuit = async () => {
  if (exiting) return;
  exiting = true;
  if (cur_serial) {
    console.log("\n收到中断，正在收尾 " + cur_serial + " ……");
    await stepRun(cur_serial, "finish");
  }
  process.exit(130);
};
process.on("SIGINT", onQuit);
process.on("SIGTERM", onQuit);

// ---------- 参数 ----------
const arg_li = process.argv.slice(2);
for (let i = 0; i < arg_li.length; ++i) {
  if (arg_li[i] === "--ref") ref_mode = true;
  else if (arg_li[i] === "-s") {
    only_serial = arg_li[++i] || "";
    if (!only_serial) die("-s 后面要跟序列号");
  } else if (arg_li[i] === "-h" || arg_li[i] === "--help") {
    const head = (await Bun.file(import.meta.path).text()).split("\n").slice(1, 12);
    console.log(head.map(l => l.replace(/^\/\/ ?/, "")).join("\n"));
    process.exit(0);
  } else die("未知参数：" + arg_li[i] + "（-h 看用法）");
}

// ---------- 主流程 ----------
const adb_bin = await adbFind();
if (!adb_bin) die("找不到 adb。安装方法见 docs/01-准备工作.md");
await u2Ensure();

const [dev_li, bad_li] = await deviceList(adb_bin);
for (const [serial, state] of bad_li)
  console.log("· " + serial + "：" + (state === "unauthorized" ? "未授权，请在手机弹窗勾选「始终允许」并点「允许」" : state + "，重插数据线或重开 USB 调试"));
if (!dev_li.length) die("没有可用的手机。检查数据线和 USB 调试，见 docs/01-准备工作.md");
let work_li = dev_li;
if (only_serial) {
  if (!dev_li.includes(only_serial)) die("设备 " + only_serial + " 不在已连接列表里（用 " + adb_bin + " devices 核对）");
  work_li = [only_serial];
}

await $`${py} tool/run.py devices`.nothrow();   // 给人看的总表：型号、系统版本、有没有现成机型脚本
for (const s of work_li) await cleanOne(s);

// ---------- 汇总 ----------
console.log("\n═══════════════ 收尾汇总 ═══════════════");
console.log("【处理结果】");
result_li.forEach(r => console.log("  " + r));
if (note_li.length) {
  console.log("【没做成 / 需要留意的】");
  note_li.forEach(n => console.log("  · " + n));
  console.log("【反馈问题】https://github.com/rddmwmddr/android-ad-cleaner/issues/new?template=bug_report.md");
  console.log("           （附上机型、系统版本和上面出错的那段输出；序列号可打码）");
} else {
  console.log("【没做成 / 需要留意的】无");
}
if (restore_li.length) {
  console.log("【怎么还原】重新打开开发者模式和 USB 调试后执行：");
  restore_li.forEach(r => console.log("  · " + r));
}
console.log("【插电常亮】已由 finish 按备份值还原");
console.log("\n【最后一步：关闭开发者模式】手机上：设置 → 搜索「开发者选项」→ 关掉总开关。");
console.log("关掉不会撤销这次的改动；要我代关就执行：" + py + " tool/run.py -s <序列号> dev-off --yes");
