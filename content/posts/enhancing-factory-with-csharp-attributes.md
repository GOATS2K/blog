---
title: "Enhancing the Factory Pattern with C# Attributes"
publishDate: "2022-12-18T00:00:00+0100"
tags: ["programming"]
---


# Introduction

Hi, welcome to the first post on my blog!

This is also my first post on the [C# Advent calendar](https://www.csadvent.christmas/), please go check out the other posts as well!

I’m a computer science student doing my final year at De Montfort University in the United Kingdom. For my bachelor thesis I decided to build a music streaming service from scratch, called Coral. The backend is written using C# with [ASP.NET](http://ASP.NET) Core and the frontend with React, in hopes that I’ll eventually make a mobile application using React Native.

# Preface

As a DJ and producer, I already have a significant collection of music in lossless format that I transcode to 192kbps AAC to listen to on my portable devices. I settled on AAC as it’s a codec that works everywhere that I listen to music and sounds great at a low bitrate.

In order to serve transcoded content in real-time, it must be processed into a chunked format that the browser can play back. One of the most common streaming protocols used today is Apple’s HTTP Live Streaming protocol (HLS). As the protocol primarily supports AAC as its lossy stereo codec of choice, I figured I’d try using it for my project.  The only quirk with AAC, is that no two AAC encoders sound the same. According to members of the audio discussion board HydrogenAudio, [the best AAC encoder to use is Apple’s encoder](https://wiki.hydrogenaud.io/index.php?title=AAC_encoders), which sadly only works on MacOS and Windows, unless you’re willing to go through the trouble of running it with Wine on Linux. This means that the transcoding system will have to accommodate for multiple AAC encoders, dependant on what platform you’re running. Maybe I’ll end up moving to Opus in the future, who knows.

# Building the factory - Prerequisites

Based on the information above, our system needs to know the following:

- What audio codecs we can output
- The name of the encoder binary
- What platforms the binary runs on

How do we provide this information to the factory? C#’s class attributes! From the first paragraph of [Microsoft’s documentation](https://learn.microsoft.com/en-us/dotnet/csharp/programming-guide/concepts/attributes/):

> Attributes provide a powerful method of associating metadata, or declarative information, with code (assemblies, types, methods, properties, and so forth). After an attribute is associated with a program entity, the attribute can be queried at run time by using a technique called *reflection.*
> 

To start off, let’s define the enums that describe the information that the factory needs to know.

```csharp
public enum Platform
{
    MacOS, Windows, Linux,
}

public enum OutputFormat
{
    AAC, Opus
}
```

Then, let’s create the attribute by inheriting from the `Attribute` class. As an encoder frontend can run on multiple platforms, let’s provide platforms in an array. The `params` keyword allows us to dynamically create an array of elements by adding however many items we want to the end of an argument list in a method call.

```csharp
public class EncoderFrontendAttribute : Attribute
{
    public string Name;
    public OutputFormat OutputFormat;
    public Platform[] SupportedPlatforms;

    public EncoderFrontendAttribute(string name, OutputFormat outputFormat, params Platform[] supportedPlatforms)
    {
        Name = name;
        OutputFormat = outputFormat;
        SupportedPlatforms = supportedPlatforms;
    }
}
```

Then, let’s create the interface that all the encoders must implement. I found out while attempting to debug an issue that `qaac` writes its command output to standard error, which was quite confusing. The property is there to ensure that I don’t accidentally throw any exceptions even though a transcoding process has completed successfully. 

```csharp
public interface IEncoder
{
    public string ExecutableName { get; }
    public bool WritesOutputToStdErr { get; }

    bool EnsureEncoderExists();
    IArgumentBuilder Configure();
    virtual TranscodingJob ConfigureTranscodingJob(TranscodingJobRequest request);
}
```

They must all provide methods to verify that they’re available on the system, an argument builder for its command line utility and finally a setup method. The interface provides a default implementation for `ConfigureTranscodingJob` which has been omitted for brevity.

# Building the factory

Let’s create an implementation of the encoder interface and build the factory.

```csharp
[EncoderFrontend(nameof(Qaac), OutputFormat.AAC, Platform.Windows)]
public class Qaac : IEncoder
{
    public string ExecutableName => "qaac";

    public bool WritesOutputToStdErr => true;

    public bool EnsureEncoderExists()
    {
        return CommonEncoderMethods.CheckEncoderExists(ExecutableName);
    }

    public IArgumentBuilder Configure()
    {
        return new QaacBuilder();
    }
}
```

Okay! To summarise so far, we’ve created a common interface for the encoders to implement and an attribute describing the metadata needed to be able to provide the right encoder for the requested format and platform. Let’s build the factory.

```csharp
public interface IEncoderFactory
{
    public Platform GetPlatform();
    public IEncoder? GetEncoder(OutputFormat format);
}

public class EncoderFactory : IEncoderFactory
{
    // it must be overrideable so it can be mocked
    public virtual Platform GetPlatform()
    {
        if (OperatingSystem.IsMacOS())
        {
            return Platform.MacOS;
        }

        if (OperatingSystem.IsLinux())
        {
            return Platform.Linux;
        }

        if (OperatingSystem.IsWindows())
        {
            return Platform.Windows;
        }

        throw new PlatformNotSupportedException("Only Windows, Linux and macOS are currently supported platforms.");
    }

    public IEncoder? GetEncoder(OutputFormat format)
    {
        var assemblies = typeof(IEncoder).Assembly;
        var encoders = assemblies
            .GetTypes()
            // get IEncoder classes
            .Where(x => x.GetInterface(nameof(IEncoder)) != null);

        foreach (var type in encoders)
        {
            var attribute = (EncoderFrontendAttribute)Attribute
                .GetCustomAttribute(type, typeof(EncoderFrontendAttribute))!;
            if (attribute.OutputFormat == format && attribute.SupportedPlatforms.Any(p => p == GetPlatform()))
            {
                return Activator.CreateInstance(type) as IEncoder;
            }
        }

        return null;
    }
}
```

The factory first gets all the classes implementing the IEncoder interface, then it iterates through the classes and fetches the attribute attached to them using reflection. Finally, if the attribute matches the output format we expected and runs on the platform we’re on, we return a new instance of the encoder.

Using the factory is as simple as this.

```csharp
var encoder = _encoderFactory.GetEncoder(OutputFormat.AAC);
```

# Testing the factory

Just to make sure the factory works as expected, I made some tests to ensure that I got the encoders I expected on various platforms. I am using NSubstitute as my mocking library, which allows me to mock parts of a class without modifying the rest of its functionality. 

```csharp
public class EncoderFactoryTests
{
    private readonly IEncoderFactory _encoderFactory;

    public EncoderFactoryTests()
    {
        _encoderFactory = Substitute.ForPartsOf<EncoderFactory>();
    }

    [Fact]
    public void GetEncoder_AACOnMacOS_ReturnsFFMPEG()
    {
        // arrange
        _encoderFactory.Configure().GetPlatform().Returns(Platform.MacOS);

        // act
        var encoder = _encoderFactory.GetEncoder(OutputFormat.AAC);

        // assert
        Assert.NotNull(encoder);
        var encoderType = encoder.GetType();
        Assert.Equal(nameof(FfmpegForMacOS), encoderType.Name);
    }

    [Fact]
    public void GetEncoder_AACOnWindows_ReturnsQaac()
    {
        // arrange
        _encoderFactory.Configure().GetPlatform().Returns(Platform.Windows);

        // act
        var encoder = _encoderFactory.GetEncoder(OutputFormat.AAC);

        // assert
        Assert.NotNull(encoder);
        var encoderType = encoder.GetType()!;
        Assert.Equal(nameof(Qaac), encoderType.Name);
    }
}
```

I hope this was helpful. Happy holidays!
