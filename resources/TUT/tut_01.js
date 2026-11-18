// 天津理工大学(tjut.edu.cn)拾光课程表适配脚本
// 数据来源：ehall 门户首页「课表」卡片（.wdkb_remark，位于同源 iframe #template-container 内）
// 注意：教务课表卡片不提供授课教师，teacher 字段留空；导入后请在设置里确认开学日期。

// 预设节次时间（天津理工大学官方作息，第 1-11 节，每节 45 分钟）
const TUT_TIME_SLOTS = [
    { "number": 1, "startTime": "08:00", "endTime": "08:45" },
    { "number": 2, "startTime": "08:55", "endTime": "09:40" },
    { "number": 3, "startTime": "10:10", "endTime": "10:55" },
    { "number": 4, "startTime": "11:05", "endTime": "11:50" },
    { "number": 5, "startTime": "14:00", "endTime": "14:45" },
    { "number": 6, "startTime": "14:55", "endTime": "15:40" },
    { "number": 7, "startTime": "16:10", "endTime": "16:55" },
    { "number": 8, "startTime": "17:05", "endTime": "17:50" },
    { "number": 9, "startTime": "18:30", "endTime": "19:15" },
    { "number": 10, "startTime": "19:25", "endTime": "20:10" },
    { "number": 11, "startTime": "20:20", "endTime": "21:05" }
];

// 星期中文 → 数字
const WEEKDAY_MAP = {
    "一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "日": 7, "天": 7
};

// 等待课表渲染的最长时间（冷启动首次打开可能较慢）
const WAIT_TIMEOUT_MS = 25000;
const WAIT_INTERVAL_MS = 500;

/**
 * 提取可读的错误信息
 * @param {*} error 捕获到的异常
 * @returns {string}
 */
function getErrorMessage(error) {
    if (!error) return "未知错误";
    if (typeof error === "string") return error;
    return error.message || String(error);
}

/**
 * 解析周次字符串，支持 `1-16周`、`1-8,10-16周`、`3-17周(单)`、`3-3周,6-6周,12-13周`
 * @param {string} raw 周次原串
 * @returns {number[]} 周次数组（升序去重）
 */
function parseWeeks(raw) {
    const weeks = [];
    const seen = {};
    if (!raw) return weeks;

    const oddOnly = raw.indexOf("单") >= 0;
    const evenOnly = raw.indexOf("双") >= 0;
    // 去掉括号说明（如「(单)」）后按逗号切段
    const body = String(raw).replace(/[（(][^)）]*[)）]/g, "");

    body.split(/[,，]/).forEach(function (seg) {
        const match = seg.match(/(\d+)\s*(?:-\s*(\d+))?/);
        if (!match) return;
        const start = parseInt(match[1], 10);
        let end = match[2] ? parseInt(match[2], 10) : start;
        if (isNaN(start) || isNaN(end)) return;
        const from = Math.min(start, end);
        const to = Math.min(Math.max(start, end), from + 60);
        for (let week = from; week <= to; week++) {
            // 只有整串明确标了单/双才过滤；同时出现单和双（极少见）时保守全保留，
            // 否则两个条件会把所有周都筛掉，导致整条课程消失。
            if (oddOnly && !evenOnly && week % 2 === 0) continue;
            if (evenOnly && !oddOnly && week % 2 === 1) continue;
            if (!seen[week]) { seen[week] = true; weeks.push(week); }
        }
    });

    return weeks.sort(function (a, b) { return a - b; });
}

/**
 * 递归收集同源 iframe 中的课表卡片元素
 * @param {Document} doc 起始文档
 * @param {number} depth 当前递归深度
 * @param {Element[]} out 结果收集数组
 * @returns {Element[]}
 */
function collectCourseCards(doc, depth, out) {
    if (!doc || depth > 6) return out;

    let cards = [];
    try { cards = doc.querySelectorAll(".wdkb_remark"); } catch (e) { cards = []; }
    for (let i = 0; i < cards.length; i++) {
        if (out.indexOf(cards[i]) < 0) out.push(cards[i]);
    }

    let frames = [];
    try { frames = doc.querySelectorAll("iframe"); } catch (e) { frames = []; }
    for (let i = 0; i < frames.length; i++) {
        let inner = null;
        try { inner = frames[i].contentDocument; } catch (e) { inner = null; }
        if (inner) collectCourseCards(inner, depth + 1, out);
    }
    return out;
}

/**
 * 读取卡片内某个选择器的纯文本
 * @param {Element} el 卡片元素
 * @param {string} selector CSS 选择器
 * @returns {string}
 */
function pickText(el, selector) {
    try {
        const node = el.querySelector(selector);
        if (!node) return "";
        return String(node.textContent || "").replace(/\s+/g, " ").trim();
    } catch (e) {
        return "";
    }
}

/**
 * 把「周次+星期+节次+地点」串切成独立时段。
 * 一个完整时段以「星期」收尾，例如 `3-3周,6-6周,12-13周 星期三 第7节-第8节 6-0203`，
 * 因此只有遇到含「星期」的片段才结束当前段，避免多周段写法丢数据。
 * @param {string} text 卡片里的时段串
 * @returns {string[]}
 */
function splitTimeSegments(text) {
    const pieces = String(text || "").split(/[,，]/);
    const segments = [];
    let buffer = "";

    pieces.forEach(function (piece) {
        const part = piece.trim();
        if (!part) return;
        buffer = buffer ? buffer + "," + part : part;
        if (part.indexOf("星期") >= 0) {
            segments.push(buffer);
            buffer = "";
        }
    });
    if (buffer) segments.push(buffer);
    return segments;
}

// 单个时段的解析规则：周次串 + 星期X + 第A节-第B节 + 详情(地点等)
const SEGMENT_PATTERN = /((?:[0-9]+\s*(?:-\s*[0-9]+)?\s*周\s*(?:[（(]\s*[单双]\s*[)）])?\s*,?\s*)+)\s*星期\s*([一二三四五六日天])\s*第\s*(\d+)\s*节\s*[-~～至]\s*第?\s*(\d+)\s*节\s*([^,，]*)/;

/**
 * 解析所有课表卡片为课程记录
 * @param {Document} root 根文档
 * @returns {Array<Object>} 课程数组
 */
function parseCourseCards(root) {
    const cards = collectCourseCards(root, 0, []);
    const courses = [];

    cards.forEach(function (card) {
        const name = pickText(card, ".wdkb_remarkname").replace(/^[\s,，]+|[\s,，]+$/g, "");
        const detail = pickText(card, ".wdkb_iconadd");
        const fallbackRoom = pickText(card, ".wdkb_icontime");
        if (!name || !detail) return;

        splitTimeSegments(detail).forEach(function (segment) {
            const match = segment.match(SEGMENT_PATTERN);
            if (!match) return;

            const weeks = parseWeeks(match[1]);
            if (!weeks.length) return;

            const day = WEEKDAY_MAP[match[2]] || 0;
            if (!day) return;

            const startSection = parseInt(match[3], 10);
            const endSection = parseInt(match[4], 10);
            if (!(startSection > 0) || !(endSection >= startSection)) return;

            const position = String(match[5] || "").trim() || fallbackRoom;

            courses.push({
                name: name,
                teacher: "",
                position: position,
                day: day,
                startSection: startSection,
                endSection: endSection,
                weeks: weeks
            });
        });
    });

    return courses;
}

/**
 * 去重（同名同地点同节次同周次视为同一条）
 * @param {Array<Object>} courses 课程数组
 * @returns {Array<Object>}
 */
function dedupeCourses(courses) {
    const seen = {};
    const result = [];

    courses.forEach(function (course) {
        const key = [course.name, course.position, course.day,
            course.startSection, course.endSection, course.weeks.join(",")].join("|");
        if (seen[key]) return;
        seen[key] = true;
        result.push(course);
    });
    return result;
}

/**
 * 页面诊断信息，用于告诉用户为什么没读到课表
 * @returns {string}
 */
function describePage() {
    let frames = 0;
    let readable = 0;
    let cards = 0;
    try {
        const all = document.querySelectorAll("iframe");
        frames = all.length;
        for (let i = 0; i < all.length; i++) {
            try { if (all[i].contentDocument) readable++; } catch (e) { /* 跨域 */ }
        }
    } catch (e) { /* ignore */ }
    try { cards = document.querySelectorAll(".wdkb_remark").length; } catch (e) { /* ignore */ }
    const href = String(location.href || "").split("?")[0].slice(0, 80);
    return "当前页面：" + href + "，课表卡片 " + cards + " 个（iframe " + frames + "，可读 " + readable + "）";
}

/**
 * 轮询等待课表渲染完成
 * @param {number} timeoutMs 最长等待时间
 * @returns {Promise<Array<Object>>}
 */
async function waitForCourses(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let courses = [];

    while (Date.now() < deadline) {
        courses = dedupeCourses(parseCourseCards(document));
        if (courses.length) return courses;
        await new Promise(function (resolve) { setTimeout(resolve, WAIT_INTERVAL_MS); });
    }
    return courses;
}

/**
 * 导入作息时间段
 */
async function saveTimeSlots() {
    try {
        await window.shiguangBridgePromise.savePresetTimeSlots(JSON.stringify(TUT_TIME_SLOTS));
    } catch (error) {
        console.error("JS: 作息导入失败", error);
    }
}

/**
 * 主流程：读取课表并导入
 */
async function runImportFlow() {
    if (!window.shiguangBridge || !window.shiguangBridgePromise) {
        console.error("JS: 拾光桥接未注入，可能不在拾光课程表内置浏览器中运行");
        return;
    }

    try {
        const host = location.hostname || "";
        if (/authserver/i.test(host)) {
            window.shiguangBridge.showToast("请先登录统一身份认证，登录完成后再点击导入。");
            return;
        }
        if (!/ehall\.tjut\.edu\.cn$/i.test(host)) {
            window.shiguangBridge.showToast("当前不在天津理工大学 ehall 页面，请登录后停留在门户首页。");
            return;
        }

        window.shiguangBridge.showToast("正在读取课表，请稍候...");
        const courses = await waitForCourses(WAIT_TIMEOUT_MS);

        if (!courses.length) {
            window.shiguangBridge.showToast("未找到课表卡片。" + describePage());
            return;
        }

        await saveTimeSlots();

        await window.shiguangBridgePromise.saveImportedCourses(JSON.stringify(courses, null, 2));

        window.shiguangBridge.showToast("课程导入成功，共导入 " + courses.length + " 条课程记录！");
        window.shiguangBridge.notifyTaskCompletion();
    } catch (error) {
        window.shiguangBridge.showToast("导入失败：" + getErrorMessage(error));
        console.error("JS: Import Error:", error);
    }
}

runImportFlow();
