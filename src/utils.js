/**
 * 时间戳转字符串
 * @param timestamp 10/13 位时间戳
 * @param type 转换类型
 * @param useUTC 是否使用 UTC0 时间
 * @returns {string} 可视化时间字符串
 */
function getTimeString(timestamp, type, useUTC = false) {
  switch (type) {
    case "1":
      timestamp *= 1000;
      break;
    case "2":
      break;
    case "3":
    default:
      if (timestamp.toString().length === 10) {
        timestamp *= 1000;
      }
      break;
  }

  let date = new Date(timestamp);
  let year = useUTC ? date.getUTCFullYear() : date.getFullYear();
  let month = (useUTC ? date.getUTCMonth() : date.getMonth()) + 1;
  let day = useUTC ? date.getUTCDate() : date.getDate();
  let hours = useUTC ? date.getUTCHours() : date.getHours();
  let minutes = useUTC ? date.getUTCMinutes() : date.getMinutes();
  let seconds = useUTC ? date.getUTCSeconds() : date.getSeconds();
  let milliseconds = useUTC ? date.getUTCMilliseconds() : date.getMilliseconds();

  month = month < 10 ? "0" + month : month;
  day = day < 10 ? "0" + day : day;
  hours = hours < 10 ? "0" + hours : hours;
  minutes = minutes < 10 ? "0" + minutes : minutes;
  seconds = seconds < 10 ? "0" + seconds : seconds;
  milliseconds =
    milliseconds < 100
      ? milliseconds < 10
        ? "00" + milliseconds
        : "0" + milliseconds
      : milliseconds;

  return (
    year + "-" + month + "-" + day + " " + hours + ":" + minutes + ":" + seconds
  );
}

/**
 * 字符串转 13 位时间戳
 * @param s 字符串
 * @returns {number} 13 位时间戳
 */
function formatTimeString(s) {
  // 替换非数字为 -
  let value = s.replace(/[^\d]/g, "-").replace(/-+/g, "-");
  let res = "";
  // 以 - 分隔
  let split = value.split("-");
  // 组装字符串为 xx/xx/xx xx:xx:xx.xxx
  for (let i = 0; i < split.length; i++) {
    let item = split[i];
    if (i === 0) {
      // 第 1 位: 年
      res += item;
    } else if (i <= 2) {
      // 2-3 位: 月日
      res += "/" + item;
    } else if (i === 3) {
      // 第 4 位: 时
      res += " " + item;
    } else if (i <= 5) {
      // 5-6 位: 分秒
      res += ":" + item;
    } else if (i === 6) {
      // 第 7 位: 毫秒
      res += "." + item;
    }
  }

  // 如果最后一位为小数点，那么应该是没有输入毫秒，去掉小数点
  if (res.endsWith(".")) {
    res = res.slice(0, value.length - 1);
  }
  let date = new Date(res);
  return date.getTime();
}

/**
 * 转换数字时间戳或者字符串
 * @param s 输入
 * @param type 转换类型
 * @returns {string|number} 字符串或者数字时间戳
 */
function convert(s, type) {
  if (s == null) {
    return "";
  }
  if (s === "") {
    return "";
  }

  let dMatch = /^(\d{8})[dD]$/.exec(s);
  if (dMatch) {
    let ymd = dMatch[1];
    let year = parseInt(ymd.slice(0, 4));
    let month = parseInt(ymd.slice(4, 6));
    let day = parseInt(ymd.slice(6, 8));
    return Date.UTC(year, month - 1, day);
  }

  // 纯时间字符串: "7:20am (UTC)" / "7:20:30 PM" / "13:45 UTC" 等
  // 只在带 am/pm 或时区标记时触发，避免误吞 "7:20" 这种交给下面老逻辑
  let timeMatch = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?\s*\(?\s*(UTC|GMT)?\s*\)?$/i.exec(
    s.trim()
  );
  if (timeMatch && (timeMatch[4] || timeMatch[5])) {
    let h = parseInt(timeMatch[1], 10);
    let m = parseInt(timeMatch[2], 10);
    let sec = timeMatch[3] ? parseInt(timeMatch[3], 10) : 0;
    let ampm = timeMatch[4] ? timeMatch[4].toLowerCase() : null;
    let isUTC = !!timeMatch[5];

    if (ampm === "am" && h === 12) h = 0;
    else if (ampm === "pm" && h !== 12) h += 12;

    let now = new Date();
    if (isUTC) {
      return Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate(),
        h,
        m,
        sec
      );
    }
    return new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      h,
      m,
      sec
    ).getTime();
  }

  if (s.indexOf(".") === -1 && !isNaN(s)) {
    return getTimeString(parseInt(s), type);
  } else {
    return formatTimeString(s);
  }
}
