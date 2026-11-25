import UIKit
@preconcurrency import Vision

struct VisionOCRResult {
    let recognizedText: String
    let lineCount: Int
}

enum VisionOCRError: LocalizedError {
    case missingCGImage
    case noTextRecognized

    var errorDescription: String? {
        switch self {
        case .missingCGImage:
            return "The selected image could not be read."
        case .noTextRecognized:
            return "Apple Vision could not find readable wine-list text in this image."
        }
    }
}

struct VisionOCRService {
    func recognizeText(in image: UIImage) async throws -> VisionOCRResult {
        guard let cgImage = image.cgImage else {
            throw VisionOCRError.missingCGImage
        }

        return try await withCheckedThrowingContinuation { continuation in
            let request = VNRecognizeTextRequest { request, error in
                if let error {
                    continuation.resume(throwing: error)
                    return
                }

                let observations = (request.results as? [VNRecognizedTextObservation]) ?? []
                // Vision's boxes are relative to the upright image, which image.size describes.
                let imageWidth = Double(image.size.width)
                let imageHeight = Double(image.size.height)
                let observationWords = observations.compactMap { observation -> [OCRWord]? in
                    guard let candidate = observation.topCandidates(1).first else {
                        return nil
                    }
                    return VisionTextLayout.words(
                        in: candidate,
                        observationBox: observation.boundingBox,
                        imageWidth: imageWidth,
                        imageHeight: imageHeight
                    )
                }
                let lines = OCRLayout.readingOrderLines(observations: observationWords, imageHeight: imageHeight)

                let recognizedText = lines.joined(separator: "\n")
                guard !recognizedText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                    continuation.resume(throwing: VisionOCRError.noTextRecognized)
                    return
                }

                continuation.resume(returning: VisionOCRResult(
                    recognizedText: recognizedText,
                    lineCount: lines.count
                ))
            }

            request.recognitionLevel = .accurate
            request.usesLanguageCorrection = true

            let handler = VNImageRequestHandler(
                cgImage: cgImage,
                orientation: CGImagePropertyOrientation(image.imageOrientation),
                options: [:]
            )

            DispatchQueue.global(qos: .userInitiated).async {
                do {
                    try handler.perform([request])
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        }
    }
}

private extension CGImagePropertyOrientation {
    init(_ orientation: UIImage.Orientation) {
        switch orientation {
        case .up:
            self = .up
        case .upMirrored:
            self = .upMirrored
        case .down:
            self = .down
        case .downMirrored:
            self = .downMirrored
        case .left:
            self = .left
        case .leftMirrored:
            self = .leftMirrored
        case .right:
            self = .right
        case .rightMirrored:
            self = .rightMirrored
        @unknown default:
            self = .up
        }
    }
}
