document.addEventListener("DOMContentLoaded", function () {
  const input = document.getElementById("input");
  const output = document.getElementById("output");
  const nowButton = document.getElementById("nowButton");
  // const copyButton = document.getElementById("btn001");
  // copyButton.onclick = focusAndSelect;

  // Set focus to input field and select content when popup opens

  // Initialize with current timestamp if localStorage has no type
  if (!localStorage.timestampJudgeType) {
    localStorage.timestampJudgeType = "3";
  }

  // Restore last input and output values
  if (localStorage.lastInput) {
    input.value = localStorage.lastInput;
    output.value = localStorage.lastOutput || "";

    updateOutput(input.value);
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

    var t = value;
    if (!isNaN(result)) {
      t = result;
    }
    let timestampUnit = document.getElementById("timestampUnit");
    timestampUnit.textContent = t.length === 10 ? "S" : "MS";

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

    console.log("int(now)", 0 + now);

    input.value = 0 + now;
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
