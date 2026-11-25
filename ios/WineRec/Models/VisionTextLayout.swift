import CoreGraphics
import Foundation
@preconcurrency import Vision

enum VisionTextLayout {
    /// Splits one observation into words with pixel boxes (top-left origin).
    /// Vision's per-range boxes are used when they look sane; otherwise each
    /// word's box is interpolated from its character offsets in the line.
    static func words(
        in candidate: VNRecognizedText,
        observationBox: CGRect,
        imageWidth: Double,
        imageHeight: Double
    ) -> [OCRWord] {
        let string = candidate.string
        guard !string.isEmpty else { return [] }
        let lineLeft = Double(observationBox.minX) * imageWidth
        let lineWidth = Double(observationBox.width) * imageWidth
        let lineTop = (1 - Double(observationBox.maxY)) * imageHeight
        let lineHeight = Double(observationBox.height) * imageHeight
        let characterCount = Double(string.count)

        var result: [OCRWord] = []
        var index = string.startIndex
        while index < string.endIndex {
            guard !string[index].isWhitespace else {
                index = string.index(after: index)
                continue
            }
            var end = index
            while end < string.endIndex, !string[end].isWhitespace {
                end = string.index(after: end)
            }
            let range = index..<end
            let text = String(string[range])
            let startOffset = Double(string.distance(from: string.startIndex, to: index))
            let endOffset = Double(string.distance(from: string.startIndex, to: end))
            var word = OCRWord(
                text: text,
                left: lineLeft + lineWidth * startOffset / characterCount,
                top: lineTop,
                width: lineWidth * (endOffset - startOffset) / characterCount,
                height: lineHeight
            )
            if let box = try? candidate.boundingBox(for: range)?.boundingBox {
                let width = Double(box.width) * imageWidth
                // Some OS versions return the whole line for any range; keep the estimate then.
                let isWholeLine = text.count < string.count && width >= lineWidth * 0.95
                if width > 0, !isWholeLine {
                    word = OCRWord(
                        text: text,
                        left: Double(box.minX) * imageWidth,
                        top: (1 - Double(box.maxY)) * imageHeight,
                        width: width,
                        height: Double(box.height) * imageHeight
                    )
                }
            }
            result.append(word)
            index = end
        }
        return result
    }
}
