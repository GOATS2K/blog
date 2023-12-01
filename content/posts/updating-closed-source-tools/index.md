---
title: "Using GitHub Releases to update my closed-source tools"
description: "Updating open source projects is easy enough, how can we leverage GitHub to update our private tools as well?"
date: "2023-12-01T00:00:00+01:00"
tags: ["programming"]
showComments: true
---

{{< alert "circle-info" >}}
This is the first article in this year's [C# Advent Calendar](https://csadvent.christmas). I'm honored to be able to be a part of such a great initiative and I cannot wait to see what you'll all write about.
{{< /alert >}}

Hey! Long time no see. 

Last summer I wrote a tool that I use on many different platforms. It runs on my Windows desktop at home, Macbook on the go and on my Linux server in the cloud. I built the tool as a self-contained executable to ensure it is as easy to use as possible.

It was great to use once it was up and running but annoying to update as it required me to manually build all the different versions of the app and copy them to the respective machines by hand. On macOS, I also had to unquarantine and codesign the binary to allow it to run in the first place as I do most of my development on my desktop.

I eventually shared the tool with some of my friends via Discord who seemed to enjoy using it as well, which unfortunately for me, added an extra dimension to the pain of distributing updates. The tool's source code exists in a private GitHub repository and I had a CI/CD pipeline for building it and running unit tests - so why don't I leverage that to create updates for my tool?

## Leveraging my private GitHub repository
I also wanted to take it a step further and use the brilliant .NET tool [versionize](https://github.com/versionize/versionize) to version new releases and generate a changelog for me.
So now - all that's required for me to create a new update is to run `versionize`, push the new tag to my GitHub repo and my CI pipeline will take care of creating a new version of my tool.

Problem solved... right?

See, that takes care of creating new binaries for each update, which is nice and all, but updating the tool is still a pain. Everytime I created a new build - I had to download every binary for all the different platforms and architectures that my tool supported and re-upload them to Discord with a changelog. My friends on macOS always forgot to run the unquarantine and codesigning command so they didn't have a great experience updating either.
Not to mention the fact that I still had to upload all the binaries to my machines as well.

## Introducing Constellation
Meet [Constellation](https://github.com/GOATS2K/Constellation), the solution to all my problems. Constellation is an application I wrote to make updating my closed source tool a bit easier. Here's an excerpt from the README:

> Constellation works by querying GitHub to fetch releases created in your private projects.

Version 1.0 of the JavaScript runtime Bun had just released around the time I thought about this update project, so I figured I'd give it a try. My TypeScript skills are horrible though - so don't expect much from the codebase. I also had to work around a few odd Elysia (the REST API framework I used) and Bun bugs at the time, so don't be surprised if some of the code makes you go "what in the world is he doing????".

### How does it work?

Constellation works by querying GitHub for releases on all your repositories. This sounds scary at first, but Constellation is made with security in mind. You generate access tokens with a claim that restricts access exclusively to your tool's repository. This means that even if your tool's Constellation token is compromised, it does not have access to your GitHub account.

My tool's binaries all follow this naming convention:

```
$application_name-$version-$platform-$architecture
```

For example:

```
constellation-v0.1.0-macos-arm64.zip
```

This way, Constellation can parse the binary's version, platform and architecture - which is all my tool needs to know to be able to fetch the correct binary. Now that you know what Constellation is, what it does and how it works, let's take a look setting it up and implementing the update feature.

## Using Constellation in my tool

I created a Docker image for Constellation so I could easily use host it from my dedicated server, however I'm sure it'll work just fine on something like [Fly.io's Hobby plan](https://fly.io/docs/about/pricing/) or any cheap VPS. Take a look at [its README](https://github.com/GOATS2K/Constellation) if you'd like to try it out.

My tool is a .NET 8.0 console application using [Spectre.Console](https://spectreconsole.net/) and [RestSharp](https://restsharp.dev/).

We will first setup the API client and update mechanism, then I'll show you how I use it in my `update` command and finally I'll show you what it looks like as a user.

### Setting up the infrastructure
First, I created the models needed to parse Constellation's responses.

```csharp
public class ReleaseVersion
{
    [JsonPropertyName("repoName")]
    public string RepoName { get; set; } = null!;

    [JsonPropertyName("description")]
    public string Description { get; set; } = null!;

    [JsonPropertyName("version")]
    public string Version { get; set; } = null!;

    [JsonPropertyName("assets")]
    public List<ReleaseAsset> Assets { get; set; } = null!;
}
```

```csharp
public class ReleaseAsset
{
    [JsonPropertyName("id")]
    public int Id { get; set; }

    [JsonPropertyName("version")]
    public string Version { get; set; } = null!;

    [JsonPropertyName("platform")]
    public string Platform { get; set; } = null!;

    [JsonPropertyName("arch")]
    public string Arch { get; set; } = null!;

    [JsonPropertyName("releaseDate")]
    public DateTime ReleaseDate { get; set; }

    [JsonPropertyName("fileName")]
    public string FileName { get; set; } = null!;

    [JsonPropertyName("contentLength")]
    public int ContentLength { get; set; }
}
```

```csharp
public class ReleaseDownload
{
    [JsonPropertyName("url")]
    public string Url { get; set; } = null!;

    [JsonPropertyName("arch")]
    public string Arch { get; set; } = null!;

    [JsonPropertyName("platform")]
    public string Platform { get; set; } = null!;

    [JsonPropertyName("version")]
    public string Version { get; set; } = null!;

    [JsonPropertyName("fileName")]
    public string FileName { get; set; } = null!;

    [JsonPropertyName("size")]
    public int Size { get; set; }
}
```

I realize now that I've been a bit inconsistent with the names for file size and content length but we move...

Then, we'll create a RestSharp client to consume in our update service.

```csharp
public class ConstellationAuthenticator : IAuthenticator
{
    // this won't expire granted the signing key stays the same
    private const string Token = "fight_me";
    
    public ValueTask Authenticate(IRestClient client, RestRequest request)
    {
        request.AddParameter(KnownHeaders.Authorization, $"Bearer {Token}", ParameterType.HttpHeader);
        return ValueTask.CompletedTask;
    }
}

public class ConstellationClient : IConstellationClient
{
    private readonly IRestClient _client;

    public ConstellationClient(IRestClient client)
    {
        _client = client;
    }

    public async Task<IReadOnlyList<ReleaseVersion>> GetVersions()
    {
        var request = new RestRequest("/versions");
        return await _client.GetAsync<List<ReleaseVersion>>(request) 
               ?? throw new UpdateClientException("Failed to get version list.");
    }

    public async Task<ReleaseDownload> GetVersion(string version, string platform, string architecture)
    {
        var request = new RestRequest($"/versions/{version}")
            .AddQueryParameter("platform", platform)
            .AddQueryParameter("arch", architecture);
        var response = await _client.ExecuteGetAsync(request);
        return JsonSerializer.Deserialize<ReleaseDownload>(response.Content!)
               ?? throw new UpdateClientException($"Failed to get {version} for {platform}-{architecture}");
    }
}
```

### Creating the update service

Our update service is responsible for two things, getting the right platform and architecture and installing the update. Note that I have omitted some code for brevity.

First we'll inject all our dependencies, here being the Constellation client, a standard HTTP client to download updates with and finally console to write to.

```csharp
public class UpdateService
{
    private readonly IConstellationClient _client;
    private readonly HttpClient _httpClient;
    private readonly IAnsiConsole _console;

    public UpdateService(IConstellationClient client, HttpClient httpClient, IAnsiConsole console)
    {
        _client = client;
        _httpClient = httpClient;
        _console = console;
    }
}
```
Then, we'll parse the semantic version numbers using [semver](https://github.com/maxhauser/semver) to figure out if we've got any updates.

```csharp
public async Task<IReadOnlyList<ReleaseVersion>> GetUpdates(string currentVersion)
{
    var currentVersionAsSemver = SemVersion.Parse(currentVersion, SemVersionStyles.Any);
    var allVersions = await _client.GetVersions();
    return allVersions.Where(version =>
    {
        var updateVersion = SemVersion.Parse(version.Version, SemVersionStyles.AllowV);
        return updateVersion.ComparePrecedenceTo(currentVersionAsSemver) > 0;
    }).ToList();
}

public async Task<ReleaseDownload> GetUpdate(string version, Platform platform, PlatformArchitecture architecture)
{
    var architectureAsString = GetArchitectureForPlatform(platform, architecture);
    return await _client.GetVersion(version, platform.ToString().ToLowerInvariant(), architectureAsString);
}
```

Alright, now that we're able to communicate with Constellation and get the latest version of the tool, let's install the update!

```csharp
public async Task InstallUpdate(ReleaseDownload update)
{
    await _console.Status()
        .Spinner(Spinner.Known.Aesthetic)
        .StartAsync("Downloading update...", async context =>
        {
            var updateStream = await _httpClient.GetStreamAsync(update.Url);
            var updateFolderPath = Path.Combine(Path.GetTempPath(), "m2-updates", update.Version);
            var updateTempDirectory = Directory.CreateDirectory(updateFolderPath);
            var updateArchive = new ZipArchive(updateStream);
            try
            {
                PerformUpdate(context, updateArchive, updateTempDirectory);
            }
            catch (Exception ex)
            {
                throw new UpdateFailedException($"Failed to install update due to: {ex} - {ex.Message}");
            } 
        });
}

private void PerformUpdate(StatusContext context,
    ZipArchive updateZip,
    DirectoryInfo updateFolder)
{
    var executingFile = Environment.ProcessPath;
    if (executingFile is null)
    {
        _console.LogFinalError("Cannot locate currently executing file.");
        return;
    }
    context.Status("Installing update...");
    updateZip.ExtractToDirectory(updateFolder.FullName);
    _console.LogInfo($"Extracted update to: {updateFolder.FullName}");
    File.Move(executingFile, $"{executingFile}.old");
    var binary = updateFolder
        .EnumerateFiles("m2*", SearchOption.TopDirectoryOnly)
        .Single();
    binary.MoveTo(executingFile);
    CleanupTempFolder(updateFolder);
}
```

The best way I found to update binaries while keeping an easy way to rollback to the old version was by simply renaming the currently running executable to `executable.old` and unzipping the update to whereever the tool is currently located.

### Tying it all together
Finally, here's the update command. Note that some code has been omitted for brevity.

```csharp
public class UpdateCommand : AsyncCommand
{
    private readonly UpdateService _updateService;
    private readonly IAnsiConsole _console;

    public UpdateCommand(UpdateService updateService, IAnsiConsole console)
    {
        _updateService = updateService;
        _console = console;
    }

    private async Task InstallUpdate(ReleaseVersion update, string? executingFile)
    {
        var updateDownload = await _updateService.GetUpdate(update.Version, GetPlatform(), GetArchitecture());
        await _updateService.InstallUpdate(updateDownload);
        RunPostInstallHook(GetPlatform(), executingFile!);
    }

    private static void RunPostInstallHook(Platform platform, string executingFile)
    {
        if (platform == Platform.Darwin)
        {
            // unquarantine
            Process.Start("xattr", $"-rd com.apple.quarantine {executingFile}");
            // codesign
            Process.Start("codesign", $"-s - {executingFile}");
            // mark executable
            Process.Start("chmod", $"+x {executingFile}");
        }
    
        if (platform == Platform.Linux)
        {
            // mark executable
            Process.Start("chmod", $"+x {executingFile}");
        }
    }

    public override async Task<int> ExecuteAsync(CommandContext context)
    {
        var executingFile = ValidateAppCanBeUpdated();
        if (executingFile is null || Path.GetExtension(executingFile) == ".dll")
        {
            _console.LogFinalError("Cannot update builds running via dll.");
            return -1;
        }
        
        var currentVersion = GetCurrentVersion();
        _console.LogInfo($"You are currently running version {currentVersion}");
        
        var updates = await GetUpdates(currentVersion);
        if (updates.Count == 0)
        {
            _console.LogSuccess("You are already up-to-date.");
            return 0;
        }

        var update = updates.First();
        ShowUpdateDescription(update);
        var installUpdate = new ConfirmationPrompt("Would you like to install the update?")
        {
            DefaultValue = true,
            ShowDefaultValue = true
        }.Show(_console);
        
        if (!installUpdate)
        {
            _console.LogFinalError("Update aborted.");
            return -1;
        }
        
        RemoveOldVersion(executingFile);
        await InstallUpdate(update, executingFile);
        _console.LogFinalSuccess($"m2 has been updated to version {update.Version}.");
        
        return 0;
    }
}
```

The update command also takes care of running some extra utilities on macOS to make sure that the executable just work after updating such as unquarantining and ad-hoc codesigning because there's no way I'm buying a developer license just for this tool.

Here's what it looks like in use.

{{< video src="update_demo.mp4">}}

Now I just need to run `m2 update` and my tool is updated.
This was a well needed quality of life improvement for both for me and my friends!

## The end

That was it for today. Thank you so much for reaching the end!

Will you be using Constellation any time soon? Have you made or used anything similar? Let me know in the comments below.

Have a merry Christmas and a happy new year!
