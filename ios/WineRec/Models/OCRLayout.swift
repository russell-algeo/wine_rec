import Foundation

/// One recognized word with its box in image pixels, origin at the top left.
struct OCRWord: Equatable {
    let text: String
    let left: Double
    let top: Double
    let width: Double
    let height: Double

    var right: Double { left + width }
    var centerX: Double { left + width / 2 }
}

/// Puts on-device OCR lines into reading order.
///
/// Single-column pages keep the original order: top to bottom, then left to
/// right. Two-column wine lists ("Wine ... 40   Wine ... 85") are read one
/// column at a time, the same way the server reads them since Nov 15
/// (main/src/providers/tesseract-layout.ts, splitTwoColumnLayout). Without
/// this, rows from the left and right columns alternate and a wine's second
/// line lands under the wrong wine.
enum OCRLayout {
    private struct Line {
        var words: [OCRWord]
        var top: Double
        var bottom: Double
        var column: Int

        init(words: [OCRWord], column: Int = 0) {
            self.words = words.sorted { $0.left < $1.left }
            self.top = words.map(\.top).min() ?? 0
            self.bottom = words.map { $0.top + $0.height }.max() ?? 0
            self.column = column
        }

        var centerY: Double { (top + bottom) / 2 }
        var text: String { words.map(\.text).joined(separator: " ") }
        var medianHeight: Double {
            let heights = words.map(\.height).sorted()
            return heights.isEmpty ? 0 : heights[heights.count / 2]
        }
    }

    /// - Parameters:
    ///   - observations: one entry per OCR text observation, each a list of words.
    ///   - imageHeight: page height in the same units, used for the row tolerance.
    static func readingOrderLines(observations: [[OCRWord]], imageHeight: Double) -> [String] {
        let lines = observations
            .map { $0.filter { !$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty } }
            .filter { !$0.isEmpty }
            .map { Line(words: $0) }
        let tolerance = 0.015 * imageHeight
        let ordered = lines.sorted { left, right in
            if abs(left.bottom - right.bottom) > tolerance {
                return left.bottom < right.bottom
            }
            return (left.words.first?.left ?? 0) < (right.words.first?.left ?? 0)
        }

        if let columns = splitTwoColumnLayout(rows: mergeIntoRows(ordered)) {
            return columns.map(\.text).filter { !$0.isEmpty }
        }
        return ordered.map(\.text).filter { !$0.isEmpty }
    }

    /// Vision often returns the two halves of a two-column row as separate
    /// observations; join observations that sit on the same row.
    private static func mergeIntoRows(_ lines: [Line]) -> [Line] {
        var rows: [Line] = []
        for line in lines.sorted(by: { $0.centerY < $1.centerY }) {
            if let last = rows.last {
                let height = max(last.medianHeight, line.medianHeight)
                if abs(last.centerY - line.centerY) <= height * 0.5 {
                    rows[rows.count - 1] = Line(words: last.words + line.words)
                    continue
                }
            }
            rows.append(line)
        }
        return rows
    }

    /// A price that can end a wine row; years (19xx/20xx) are vintages, not prices.
    static func isRowEndPrice(_ text: String) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let price = #"^[$€£]?\d{2,4}(?:[.,]\d{2})?[.,]?$"#
        let year = #"^(?:19|20)\d{2}$"#
        return trimmed.range(of: price, options: .regularExpression) != nil
            && trimmed.range(of: year, options: .regularExpression) == nil
    }

    private static func hasLetters(_ word: OCRWord) -> Bool {
        word.text.range(of: #"\p{L}{2,}"#, options: .regularExpression) != nil
    }

    private struct GapPoint {
        let x: Double
        let y: Double
    }

    private struct Gutter {
        let slope: Double
        let intercept: Double

        func x(at y: Double) -> Double { intercept + slope * y }
    }

    private static func fit(_ points: [GapPoint]) -> Gutter {
        let count = Double(points.count)
        let meanY = points.reduce(0.0) { $0 + $1.y } / count
        let meanX = points.reduce(0.0) { $0 + $1.x } / count
        let varY = points.reduce(0.0) { $0 + ($1.y - meanY) * ($1.y - meanY) }
        let slope = varY > 0
            ? points.reduce(0.0) { $0 + ($1.y - meanY) * ($1.x - meanX) } / varY
            : 0
        let bounded = max(-0.1, min(0.1, slope))
        return Gutter(slope: bounded, intercept: meanX - bounded * meanY)
    }

    /// Returns the rows split at the gutter, left column first, or nil when the
    /// page does not look like a two-column list.
    private static func splitTwoColumnLayout(rows: [Line]) -> [Line]? {
        guard rows.count >= 8 else { return nil }
        let words = rows.flatMap(\.words)
        guard let pageLeft = words.map(\.left).min(),
              let pageRight = words.map(\.right).max() else { return nil }
        let span = pageRight - pageLeft
        guard span > 0 else { return nil }
        let minimumGaps = max(4.0, Double(rows.count) * 0.12)

        var gaps: [GapPoint] = []
        for row in rows {
            let height = row.medianHeight
            guard row.words.count >= 3 else { continue }
            for index in 1..<(row.words.count - 1) {
                let price = row.words[index]
                let next = row.words[index + 1]
                let gap = next.left - price.right
                let x = price.right + gap / 2
                let relative = (x - pageLeft) / span
                if relative < 0.2 || relative > 0.8 || gap < 1.5 * height { continue }
                if !isRowEndPrice(price.text) { continue }
                if !row.words[..<index].contains(where: hasLetters) { continue }
                if row.words[(index + 1)...].filter(hasLetters).count < 2 { continue }
                gaps.append(GapPoint(x: x, y: row.centerY))
                break
            }
        }
        guard Double(gaps.count) >= minimumGaps else { return nil }

        // Fit the gutter, dropping gaps far from the median, and refit once.
        let sortedX = gaps.map(\.x).sorted()
        let medianX = sortedX[sortedX.count / 2]
        var inliers = gaps.filter { abs($0.x - medianX) <= span * 0.08 }
        guard Double(inliers.count) >= minimumGaps else { return nil }
        var gutter = fit(inliers)
        inliers = gaps.filter { abs($0.x - gutter.x(at: $0.y)) <= span * 0.04 }
        guard Double(inliers.count) >= minimumGaps else { return nil }
        gutter = fit(inliers)

        var split: [Line] = []
        var rightSegments = 0
        var rightSegmentsWithPrice = 0
        for row in rows {
            let x = gutter.x(at: row.centerY)
            let left = row.words.filter { $0.centerX < x }
            let right = row.words.filter { $0.centerX >= x }
            if !left.isEmpty { split.append(Line(words: left, column: 0)) }
            if !right.isEmpty {
                split.append(Line(words: right, column: 1))
                if right.contains(where: hasLetters) {
                    rightSegments += 1
                    if right.contains(where: { isRowEndPrice($0.text) }) { rightSegmentsWithPrice += 1 }
                }
            }
        }
        // Price-then-tasting-notes rows look similar; a real second column has its own prices.
        guard rightSegments > 0, Double(rightSegmentsWithPrice) / Double(rightSegments) >= 0.4 else {
            return nil
        }
        return split.sorted { left, right in
            if left.column != right.column { return left.column < right.column }
            if left.top != right.top { return left.top < right.top }
            return (left.words.first?.left ?? 0) < (right.words.first?.left ?? 0)
        }
    }
}
