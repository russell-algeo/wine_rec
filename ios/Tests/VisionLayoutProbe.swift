import CoreGraphics
import Foundation
import ImageIO
@preconcurrency import Vision

// Runs Apple Vision on wine-list images on a Mac and prints the text in the
// order the iPhone app now sends it, next to the old row-by-row order.
//   swiftc ios/WineRec/Models/OCRLayout.swift ios/WineRec/Models/VisionTextLayout.swift \
//     ios/Tests/VisionLayoutProbe.swift -o /tmp/vision-layout-probe
//   /tmp/vision-layout-probe image.jpg [--expect-two-columns FIRST_LEFT_LAST LINE_RIGHT_FIRST]
@main
struct VisionLayoutProbe {
    static func main() throws {
        var arguments = Array(CommandLine.arguments.dropFirst())
        var expectation: (lastLeft: String, firstRight: String)?
        if let flag = arguments.firstIndex(of: "--expect-two-columns"), flag + 2 < arguments.count {
            expectation = (arguments[flag + 1], arguments[flag + 2])
            arguments.removeSubrange(flag...(flag + 2))
        }
        guard let path = arguments.first else {
            print("usage: vision-layout-probe image [--expect-two-columns LAST_LEFT FIRST_RIGHT]")
            exit(2)
        }
        guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
              let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
            print("could not read \(path)")
            exit(2)
        }

        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = true
        try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
        let observations = request.results ?? []
        let width = Double(image.width)
        let height = Double(image.height)

        let oldOrder = observations
            .compactMap { observation -> (String, CGFloat, CGFloat)? in
                guard let text = observation.topCandidates(1).first?.string else { return nil }
                return (text, observation.boundingBox.minY, observation.boundingBox.minX)
            }
            .sorted { abs($0.1 - $1.1) > 0.015 ? $0.1 > $1.1 : $0.2 < $1.2 }
            .map(\.0)
        let words = observations.compactMap { observation -> [OCRWord]? in
            guard let candidate = observation.topCandidates(1).first else { return nil }
            return VisionTextLayout.words(
                in: candidate,
                observationBox: observation.boundingBox,
                imageWidth: width,
                imageHeight: height
            )
        }
        let newOrder = OCRLayout.readingOrderLines(observations: words, imageHeight: height)

        print("== \(path)")
        print("-- old order (\(oldOrder.count) lines)")
        oldOrder.forEach { print($0) }
        print("-- new order (\(newOrder.count) lines)")
        newOrder.forEach { print($0) }

        if let expectation {
            guard let lastLeft = newOrder.firstIndex(where: { $0.contains(expectation.lastLeft) }),
                  let firstRight = newOrder.firstIndex(where: { $0.contains(expectation.firstRight) }) else {
                print("FAIL: expected lines not found")
                exit(1)
            }
            guard lastLeft < firstRight else {
                print("FAIL: '\(expectation.firstRight)' is read before '\(expectation.lastLeft)'")
                exit(1)
            }
            print("PASS: left column read before right column")
        }
    }
}
