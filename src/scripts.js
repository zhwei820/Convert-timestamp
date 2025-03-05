document.addEventListener('DOMContentLoaded', function() {
    const input = document.getElementById('input');
    const output = document.getElementById('output');
    const nowButton = document.getElementById('nowButton');
    const copyButton = document.getElementById('copyButton');

    // Initialize with current timestamp if localStorage has no type
    if (!localStorage.timestampJudgeType) {
        localStorage.timestampJudgeType = '3';
    }

    function updateOutput(value) {
        if (!value) {
            output.value = '';
            return;
        }

        let result = convert(value, localStorage.timestampJudgeType);
        output.value = result;
    }

    // Handle input changes
    input.addEventListener('input', function(e) {
        updateOutput(e.target.value);
    });

    // Get current timestamp
    nowButton.onclick = function() {
        let currentTime = new Date().getTime();
        input.value = currentTime;
        updateOutput(currentTime.toString());
    };

    // Copy result to clipboard
    copyButton.onclick = function() {
        if (output.value) {
            output.select();
            document.execCommand('copy');
            // Deselect the text
            window.getSelection().removeAllRanges();
        }
    };
});
