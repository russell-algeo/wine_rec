import Foundation

// Build and run on any Mac:
//   swiftc ios/WineRec/Models/OCRLayout.swift ios/Tests/OCRLayoutCheck.swift -o /tmp/ocr-layout-check && /tmp/ocr-layout-check
@main
struct OCRLayoutCheck {
    /// Lays out words left to right on one row, 10 px per character, 18 px apart.
    static func row(_ texts: [String], x: Double, y: Double, height: Double = 20) -> [OCRWord] {
        var cursor = x
        return texts.map { text in
            let width = Double(text.count) * 10
            defer { cursor += width + 18 }
            return OCRWord(text: text, left: cursor, top: y, width: width, height: height)
        }
    }

    static func main() {
        // Two-column list, each half of a row returned as its own observation.
        let left = [
            ["Sancerre", "Vacheron", "2022", "68"],
            ["Chablis", "Moreau", "2021", "72"],
            ["Muscadet", "Pepiere", "2023", "45"],
            ["Riesling", "Trimbach", "2020", "58"],
            ["Soave", "Pieropan", "2022", "52"],
            ["Albarino", "Forjas", "2022", "49"],
            ["Gruner", "Hirsch", "2021", "55"],
            ["Txakoli", "Ameztoi", "2023", "47"],
            ["Vermentino", "Sardus", "2022", "50"],
        ]
        let right = [
            ["Barolo", "Vietti", "2019", "140"],
            ["Rioja", "Lopez", "2012", "95"],
            ["Morgon", "Foillard", "2022", "70"],
            ["Syrah", "Jamet", "2020", "160"],
            ["Etna", "Benanti", "2021", "75"],
            ["Chinon", "Baudry", "2021", "66"],
            ["Bandol", "Tempier", "2020", "98"],
            ["Barbera", "Vajra", "2022", "57"],
            ["Nebbiolo", "Burlotto", "2021", "88"],
        ]
        var observations: [[OCRWord]] = []
        for index in left.indices {
            let y = 100 + Double(index) * 40
            observations.append(row(left[index], x: 40, y: y))
            // A slight downward slope on the right column, like a tilted photo.
            observations.append(row(right[index], x: 700, y: y + 3))
        }
        let twoColumn = OCRLayout.readingOrderLines(observations: observations, imageHeight: 600)
        let expected = left.map { $0.joined(separator: " ") } + right.map { $0.joined(separator: " ") }
        precondition(twoColumn == expected, "two-column order: \(twoColumn)")

        // The same rows merged into one observation per row read the same way.
        let merged = left.indices.map { index -> [OCRWord] in
            let y = 100 + Double(index) * 40
            return row(left[index], x: 40, y: y) + row(right[index], x: 700, y: y)
        }
        precondition(
            OCRLayout.readingOrderLines(observations: merged, imageHeight: 600) == expected,
            "merged two-column order"
        )

        // A single column keeps top-to-bottom order, observation by observation.
        let single = left.indices.map { row(left[$0], x: 40, y: 100 + Double($0) * 40) }
        precondition(
            OCRLayout.readingOrderLines(observations: single, imageHeight: 600) == left.map { $0.joined(separator: " ") },
            "single column order"
        )

        // Price-then-tasting-notes rows have no prices on the right, so no split.
        let notes = left.indices.map { index -> [OCRWord] in
            let y = 100 + Double(index) * 40
            return row(left[index], x: 40, y: y) + row(["bright", "citrus", "and", "stone"], x: 700, y: y)
        }
        let notesLines = OCRLayout.readingOrderLines(observations: notes, imageHeight: 600)
        precondition(notesLines.count == left.count, "tasting notes stay on their row: \(notesLines)")
        precondition(notesLines[0] == "Sancerre Vacheron 2022 68 bright citrus and stone", notesLines[0])

        precondition(OCRLayout.isRowEndPrice("68") && OCRLayout.isRowEndPrice("$140") && OCRLayout.isRowEndPrice("45.00"))
        precondition(!OCRLayout.isRowEndPrice("2019") && !OCRLayout.isRowEndPrice("Rioja"))
        print("OCRLayoutCheck passed")
    }
}
