import CoreGraphics
import Foundation
import ImageIO
@preconcurrency import Vision

/// Word boxes sent with the recognized text so the server can run the same
/// layout pass it runs on its own OCR. Pixels, top-left origin, upright image.
struct ClientOCRLayout: Codable, Equatable {
    struct Word: Codable, Equatable {
        let text: String
        let left: Double
        let top: Double
        let width: Double
        let height: Double
    }

    struct Line: Codable, Equatable {
        let words: [Word]
    }

    let imageWidth: Double
    let imageHeight: Double
    let lines: [Line]
}

struct VisionOCROutput {
    let recognizedText: String
    let lineCount: Int
    let layout: ClientOCRLayout
}

/// Apple Vision settings the app uses. The Mac evaluation tool runs the same
/// code with the same defaults, so what it measures is what the app sends.
struct VisionOCRSettings {
    var usesLanguageCorrection = true
    var recognitionLanguages: [String]? = nil
    var minimumTextHeight: Float? = nil

    static let app = VisionOCRSettings()
}

/// UIKit-free core of on-device OCR, shared by the app and the Mac tools.
enum VisionOCRCore {
    static func recognize(
        cgImage: CGImage,
        orientation: CGImagePropertyOrientation,
        settings: VisionOCRSettings = .app
    ) throws -> VisionOCROutput {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = settings.usesLanguageCorrection
        if let languages = settings.recognitionLanguages {
            request.recognitionLanguages = languages
        }
        if let minimumTextHeight = settings.minimumTextHeight {
            request.minimumTextHeight = minimumTextHeight
        }
        try VNImageRequestHandler(cgImage: cgImage, orientation: orientation, options: [:]).perform([request])
        let observations = request.results ?? []

        // Vision's boxes are relative to the upright image.
        let rotated = [.left, .leftMirrored, .right, .rightMirrored].contains(orientation)
        let imageWidth = Double(rotated ? cgImage.height : cgImage.width)
        let imageHeight = Double(rotated ? cgImage.width : cgImage.height)

        let observationWords = observations.compactMap { observation -> [OCRWord]? in
            guard let candidate = observation.topCandidates(1).first else { return nil }
            return VisionTextLayout.words(
                in: candidate,
                observationBox: observation.boundingBox,
                imageWidth: imageWidth,
                imageHeight: imageHeight
            )
        }
        let lines = OCRLayout.readingOrderLines(observations: observationWords, imageHeight: imageHeight)
        let layout = ClientOCRLayout(
            imageWidth: imageWidth,
            imageHeight: imageHeight,
            lines: observationWords.filter { !$0.isEmpty }.map { words in
                ClientOCRLayout.Line(words: words.map {
                    ClientOCRLayout.Word(
                        text: $0.text,
                        left: rounded($0.left),
                        top: rounded($0.top),
                        width: rounded($0.width),
                        height: rounded($0.height)
                    )
                })
            }
        )
        return VisionOCROutput(recognizedText: lines.joined(separator: "\n"), lineCount: lines.count, layout: layout)
    }

    private static func rounded(_ value: Double) -> Double {
        (value * 10).rounded() / 10
    }
}
