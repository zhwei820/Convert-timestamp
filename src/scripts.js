document.addEventListener("DOMContentLoaded", function () {
  const input = document.getElementById("input");
  const output = document.getElementById("output");
  const nowButton = document.getElementById("nowButton");
  const copyButton = document.getElementById("copyButton");

  // Initialize with current timestamp if localStorage has no type
  if (!localStorage.timestampJudgeType) {
    localStorage.timestampJudgeType = "3";
  }

  // Restore last input and output values
  if (localStorage.lastInput) {
    input.value = localStorage.lastInput;
    output.value = localStorage.lastOutput || "";
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
  }

  // Handle input changes
  input.addEventListener("input", function (e) {
    updateOutput(e.target.value);
  });

  // Get current timestamp
  nowButton.onclick = function () {
    let now = Date.now();
    input.value = now;
    let result = convert(now.toString(), localStorage.timestampJudgeType);
    output.value = result.time;
    let timestampUnit = document.getElementById("timestampUnit");
    timestampUnit.textContent = now.toString().length === 10 ? "S" : "MS";
  };

  // Copy result to clipboard
  copyButton.onclick = function () {
    if (output.value) {
      output.select();
      document.execCommand("copy");
      // Deselect the text
      window.getSelection().removeAllRanges();
    }
  };
});
