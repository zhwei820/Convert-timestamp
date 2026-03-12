document.addEventListener("DOMContentLoaded", function () {
  const input = document.getElementById("input");
  const output = document.getElementById("output");
  const nowButton = document.getElementById("nowButton");
  const todayButton = document.getElementById("todayButton");
  const todayButton8 = document.getElementById("todayButton8");
  const add8hButton = document.getElementById("add8hButton");
  const timestampUnit = document.getElementById("timestampUnit");
  // const copyButton = document.getElementById("btn001");
  // copyButton.onclick = focusAndSelect;

  // Set focus to input field and select content when popup opens

  // Initialize with current timestamp if localStorage has no type
  if (!localStorage.timestampJudgeType) {
    localStorage.timestampJudgeType = "3";
  }

  // Initialize timestamp unit preference
  if (!localStorage.timestampUnit) {
    localStorage.timestampUnit = "MS";
  }

  // Restore last input and output values
  if (localStorage.lastInput) {
    input.value = localStorage.lastInput;
    output.value = localStorage.lastOutput || "";

    updateOutput(input.value);
  }
  function isStringNumber(str) {
    return !isNaN(Number(str)) && isFinite(Number(str));
  }

  function updateOutput(value) {
    if (!value) {
      output.value = "";
      return;
    }

    let result = convert(value, localStorage.timestampJudgeType);
    output.value = result;

    // Save current input and output
    localStorage.lastInput = value;
    localStorage.lastOutput = result;

    var t = output.value;
    if (!isStringNumber(output.value)) {
      //is number
      t = input.value;
    }

    // Update timestamp unit display
    let isSeconds = localStorage.timestampUnit === "S";
    if (isSeconds && t.length === 13) {
      t = Math.floor(parseInt(t) / 1000).toString();
    } else if (!isSeconds && t.length === 10) {
      t = (parseInt(t) * 1000).toString();
    }
    if (!isStringNumber(output.value)) {
      //is number
      input.value = t;
    } else {
      output.value = t;
    }

    timestampUnit.textContent = isSeconds ? "S" : "MS";

    // Update UTC0 time
    let utc0Time = document.getElementById("utc0Time");
    let timestamp = parseInt(t);
    if (!isNaN(timestamp)) {
      if (t.length === 10) {
        timestamp *= 1000;
      }
      utc0Time.value = getTimeString(timestamp, "", true);
    } else {
      utc0Time.value = "";
    }
  }

  // Handle input changes
  input.addEventListener("input", function (e) {
    updateOutput(e.target.value);
  });

  // Get current timestamp
  nowButton.onclick = function () {
    let now = Date.now();
    let date = new Date(now);
    // 将该 Date 对象的毫秒部分设置为 0
    date.setMilliseconds(0);
    // 从更新后的 Date 对象中获取新的时间戳
    now = date.getTime();

    if (localStorage.timestampUnit === "S") {
      now = Math.floor(now / 1000);
    }

    input.value = now;
    updateOutput(input.value);
  };

  // Get today timestamp
  todayButton.onclick = function () {
    let now = Date.now();
    let date = new Date(now);
    // Set time to start of day (00:00:00)
    date.setHours(0, 0, 0, 0);
    // Get timestamp for start of day
    now = date.getTime();

    if (localStorage.timestampUnit === "S") {
      now = Math.floor(now / 1000);
    }

    input.value = now;
    updateOutput(input.value);
  };

  // Get today 8:00 AM timestamp
  todayButton8.onclick = function () {
    let now = Date.now();
    let date = new Date(now);
    // Set time to 8:00:00
    date.setHours(8, 0, 0, 0);
    // Get timestamp for 8:00 AM
    now = date.getTime();

    if (localStorage.timestampUnit === "S") {
      now = Math.floor(now / 1000);
    }

    input.value = now;
    updateOutput(input.value);
  };

  // Add 8 hours to current input timestamp
  add8hButton.onclick = function () {
    let val = input.value.trim();
    if (!val) return;
    let ts = parseInt(val);
    if (isNaN(ts)) return;
    const eightHours =
      localStorage.timestampUnit === "S" ? 8 * 3600 : 8 * 3600 * 1000;
    input.value = (ts + eightHours).toString();
    updateOutput(input.value);
  };

  // Toggle timestamp unit
  timestampUnit.onclick = function () {
    localStorage.timestampUnit =
      localStorage.timestampUnit === "MS" ? "S" : "MS";
    updateOutput(input.value);
  };

  focusAndSelect();
});

function focusAndSelect() {
  // 获取输入框元素
  const input = document.getElementById("input");
  console.log("input", input);

  // 让输入框获得焦点
  input.focus();
  // 全选输入框中的内容
  input.select();
}
