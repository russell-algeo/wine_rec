import CoreGraphics
import Foundation
import ImageIO

// Runs the app's own Apple Vision code (VisionOCRCore) on images on a Mac and
// writes, for each image, the JSON body the app would POST to /api/client-ocr.
//   swiftc ios/WineRec/Models/OCRLayout.swift ios/WineRec/Models/VisionTextLayout.swift \
//     ios/WineRec/Models/VisionOCRCore.swift ios/Tests/VisionOCRDump.swift -o /tmp/vision-ocr-dump
//   /tmp/vision-ocr-dump --out DIR [--no-language-correction] [--languages en-US,fr-FR] image...
@main
struct VisionOCRDump {
    struct Dump: Encodable {
        let sourceFilename: String
        let recognizedText: String
        let layout: ClientOCRLayout
        let settings: String
        let milliseconds: Int
    }

    static func main() throws {
        var arguments = Array(CommandLine.arguments.dropFirst())
        var settings = VisionOCRSettings.app
        var settingsLabel = "app"
        var outputDirectory: URL?
        var images: [String] = []
        while !arguments.isEmpty {
            let argument = arguments.removeFirst()
            switch argument {
            case "--out":
                outputDirectory = URL(fileURLWithPath: arguments.removeFirst())
            case "--no-language-correction":
                settings.usesLanguageCorrection = false
                settingsLabel += "+no-lc"
            case "--languages":
                let languages = arguments.removeFirst().split(separator: ",").map(String.init)
                settings.recognitionLanguages = languages
                settingsLabel += "+lang=\(languages.joined(separator: ","))"
            default:
                images.append(argument)
            }
        }
        guard let outputDirectory, !images.isEmpty else {
            print("usage: vision-ocr-dump --out DIR [--no-language-correction] [--languages L1,L2] image...")
            exit(2)
        }
        try FileManager.default.createDirectory(at: outputDirectory, withIntermediateDirectories: true)

        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        for path in images {
            let url = URL(fileURLWithPath: path)
            guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
                  let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
                print("could not read \(path)")
                exit(2)
            }
            // The app passes UIImage.imageOrientation, which comes from the same EXIF tag.
            let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any]
            let rawOrientation = (properties?[kCGImagePropertyOrientation] as? NSNumber)?.uint32Value ?? 1
            let orientation = CGImagePropertyOrientation(rawValue: rawOrientation) ?? .up

            let started = Date()
            let output = try VisionOCRCore.recognize(cgImage: image, orientation: orientation, settings: settings)
            let dump = Dump(
                sourceFilename: url.lastPathComponent,
                recognizedText: output.recognizedText,
                layout: output.layout,
                settings: settingsLabel,
                milliseconds: Int(Date().timeIntervalSince(started) * 1000)
            )
            let name = url.deletingPathExtension().lastPathComponent + ".json"
            try encoder.encode(dump).write(to: outputDirectory.appendingPathComponent(name))
            print("\(url.lastPathComponent): \(output.lineCount) lines, \(dump.milliseconds) ms, orientation \(rawOrientation)")
        }
    }
}
