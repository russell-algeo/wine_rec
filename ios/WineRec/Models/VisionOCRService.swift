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
                let lines = observations
                    .compactMap { observation -> (text: String, y: CGFloat, x: CGFloat)? in
                        guard let candidate = observation.topCandidates(1).first else {
                            return nil
                        }
                        let text = candidate.string.trimmingCharacters(in: .whitespacesAndNewlines)
                        guard !text.isEmpty else {
                            return nil
                        }
                        return (text, observation.boundingBox.minY, observation.boundingBox.minX)
                    }
                    .sorted {
                        if abs($0.y - $1.y) > 0.015 {
                            return $0.y > $1.y
                        }
                        return $0.x < $1.x
                    }
                    .map(\.text)

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
