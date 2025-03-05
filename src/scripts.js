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
  }

  // Handle input changes
  input.addEventListener("input", function (e) {
    updateOutput(e.target.value);
  });

  // Get current timestamp
  nowButton.onclick = function () {
    let now = Date.now();
    console.log("int(now)", 0 + now);

    input.value = 0 + now;
    updateOutput(input.value);
  };

  // // Copy result to clipboard
  // copyButton.onclick = function () {
  //   if (output.value) {
  //     output.select();
  //     document.execCommand("copy");
  //     // Deselect the text
  //     window.getSelection().removeAllRanges();
  //   }
  // };
});
