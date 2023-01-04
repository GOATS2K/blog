function hexToRgb(hex: string) {
    var bigint = parseInt(hex, 16);
    var r = (bigint >> 16) & 255;
    var g = (bigint >> 8) & 255;
    var b = bigint & 255;

    return `${r}, ${g}, ${b}`;
}

function parseColorString(colorString: string): string {
    const hexMatchingRegex = "(\#[a-fA-F0-9]+)(?=;)"
    let match = colorString.match(hexMatchingRegex);
    if (match == null) {
        console.log("Something went wrong parsing: ", colorString)
        return "";
    }
    let result = match[0]
    let replaced = colorString.replace(result, hexToRgb(result.replace("#", "")))
    return replaced
}

function processStylesheet(sheet: string) {
    let newString = [] as string[]
    let split = sheet.split("\n")
    for (let string of split) {
        if (string == '') {
            continue;
        }
        newString.push(parseColorString(string));
    }
    console.log(newString.join('\n'))
}

processStylesheet(`
--natural-gray-50: #f8f8f8;
--natural-gray-100: #f0f0f0;
--natural-gray-200: #e4e4e4;
--natural-gray-300: #d1d1d0;
--natural-gray-400: #b5b5b4;
--natural-gray-500: #929190;
--natural-gray-600: #828180;
--natural-gray-700: #6b6b6a;
--natural-gray-800: #5b5a59;
--natural-gray-900: #4f4e4d;
`)
