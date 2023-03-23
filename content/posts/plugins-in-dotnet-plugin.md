---
title: "Plugins in .NET: Creating a plugin"
description: "Let's see the plugin system in action by creating an actual plugin"
date: "2023-03-23T21:00:00+01:00"
tags: ["programming", "coral", "plugins"]
showComments: true
---

This is part 2 of the Plugins in .NET series, you can find the previous article [here](/posts/plugins-in-dotnet-host/).

## Introduction
As mentioned in the last article, we will be building a [Last.fm](https://last.fm) plugin to log music playback in Coral.

## Building a Coral plugin

The plugin API is nowhere near final and will be evolving quickly. This is just a snapshot of what the API looks like today and it can change at any minute.

First, ensure that the assembly can be dynamically loaded by changing the project configuration.

```
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net7.0</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
	<EnableDynamicLoading>true</EnableDynamicLoading>
  </PropertyGroup>

  <ItemGroup>
    <PackageReference Include="Microsoft.Extensions.DependencyInjection.Abstractions" Version="7.0.0" />
    <PackageReference Include="Newtonsoft.Json" Version="9.0.1" />
    <PackageReference Include="RestSharp" Version="108.0.3" />
  </ItemGroup>

  <ItemGroup>
	  <ProjectReference Include="..\Coral.PluginBase\Coral.PluginBase.csproj">
		  <PrivateAssets>false</PrivateAssets>
		  <ExcludeAssets>runtime</ExcludeAssets>
	  </ProjectReference>
	</ItemGroup>
</Project>
```

Let’s look at what’s required to build a plugin from Coral’s side.

 The plugin needs to declare a configuration and metadata via the `IPlugin` interface, a controller via the `PluginBaseController` class and a service via the `IPluginService` class. The plugin service interface is there to allow the plugin host to register event handlers created by the plugin. Here’s what they look like.

```csharp
public interface IPlugin
{
  string Name { get; }
  string Description { get; }

  public void ConfigureServices(IServiceCollection serviceCollection);
}
```

```csharp
[ApiController]
[Route("api/plugin/[controller]")]
public class PluginBaseController : ControllerBase
{
}
```

The base controller is there to ensure that plugins live under the `/api/plugin/name` route.

```csharp
public interface IPluginService
{
  public void RegisterEventHandlers();
  public void UnregisterEventHandlers();
}
```

Now, let’s take a look at how these are implemented in the [Last.fm](http://Last.fm) plugin.

```csharp
public class LastFMPlugin : IPlugin
{
    public string Name => "Last.fm";

    public string Description => "A simple track scrobbler.";

    public IConfiguration AddConfiguration()
    {
        var configurationBuilder = new ConfigurationBuilder();
        configurationBuilder
            .SetBasePath(ApplicationConfiguration.Plugins)
            .AddJsonFile("LastFmConfiguration.json");
        return configurationBuilder.Build();
    }

    public void ConfigureServices(IServiceCollection serviceCollection)
    {
        var configuration = AddConfiguration();
        serviceCollection.Configure<LastFmConfiguration>(configuration);

        serviceCollection.AddScoped<ILastFmService, LastFmService>();
        serviceCollection.AddScoped<IPluginService, LastFmService>();
    }
}
```

It simply declares what it needs to run to the service collection, which is built at plugin initialization and maintained by the plugin host. 

Let's take a brief look back at the plugin host, particularly the function responsible for creating the ServiceCollection.

```csharp
private IServiceCollection ConfigureServiceCollectionForPlugin(IPlugin plugin)
{
    // set up servicecollection
    var serviceCollection = new ServiceCollection();
    // run ConfigureServices with new service collection        
    plugin.ConfigureServices(serviceCollection);
    serviceCollection.AddLogging(opt => opt.AddConsole());
    
    // allow plugins to access host services via proxy
    // it is important to note that the ServiceProxy in the plugin service collection
    // would normally contain a reference to its own service provider
    // so here we are telling the service collection to create the proxy
    // using the service provider injected in this class
    serviceCollection.AddScoped<IHostServiceProxy, HostServiceProxy>(_ => new HostServiceProxy(_serviceProvider));
    return serviceCollection;
}
```
Because the plugin needs access to the host's event emitters, we need to allow the plugin to access the host's ServiceProvider through a proxy class. Note that we're also restricting access to types belonging to the `Coral.Events` assembly.

{{< alert >}}
This restriction will not stop plugin developers from accessing host services if they really want to. As plugin controllers are loaded directly into the host, they also have unrestricted access to the host's `ServiceProvider` instance. The restriction is in place to promote clean plugin design and development guidance.
{{< /alert >}}


```csharp
public class HostServiceProxy: IHostServiceProxy
{
    private readonly IServiceProvider _serviceProvider;

    public HostServiceProxy(IServiceProvider serviceProvider)
    {
        _serviceProvider = serviceProvider;
    }

    public TType GetHostService<TType>()
        where TType : class
    {
        using var scope = _serviceProvider.CreateScope();
        var assemblyName = typeof(TType).Assembly.GetName().Name;
        if (assemblyName != "Coral.Events")
        {
            throw new ArgumentException("You may only access types belonging to the Coral.Events assembly.");
        }
        return scope.ServiceProvider.GetRequiredService<TType>();
    }
}
```

Let’s take a look at the [Last.fm](http://Last.fm) plugin service. I’ve omitted tons of methods here for brevity, but as you can see, there is a lot of things the plugin has access to!

```csharp
public interface ILastFmService
{
  public string GetApiKey();
  public void SetUserToken(string token);
}

public class LastFmService : ILastFmService, IPluginService
{
    private readonly ILogger<LastFmService> _logger;
    private readonly TrackPlaybackEventEmitter _playbackEvents;
    private readonly RestClient _client;
    private readonly LastFmConfiguration _configuration;
    private LastFmUserSession? _session;
    private readonly string _sessionFile = Path.Join(ApplicationConfiguration.Plugins, "LastFmUser.json");
    private (TrackDto Track, DateTimeOffset Timestamp)? _lastPlayed;

    public LastFmService(ILogger<LastFmService> logger, IHostServiceProxy serviceProxy, IOptions<LastFmConfiguration> options)
    {
        _logger = logger;
        _playbackEvents = serviceProxy.GetHostService<TrackPlaybackEventEmitter>();
        _client = new RestClient("https://ws.audioscrobbler.com/2.0/");
        _configuration = options.Value;
        _client.UseSystemTextJson();
    }

    private void Scrobble(object? sender, TrackPlaybackEventArgs e)
    {
        _logger.LogDebug("Scrobble event received!");
        UpdateNowPlaying(e.Track);
        // if playback duration was less than half the track's duration in seconds,
        // skip scrobble
        if (_lastPlayed.HasValue)
        {
            var playbackTime = DateTimeOffset.UtcNow - _lastPlayed.Value.Timestamp;
            _logger.LogInformation("Track played for {PlaybackTime} seconds", playbackTime.TotalSeconds);

            var trackDuration = _lastPlayed.Value.Track.DurationInSeconds;
            _logger.LogInformation("Track duration: {TrackDuration} seconds", trackDuration);
            // 4 minutes or half time, whichever comes first
            var scrobbleRequirement = Math.Min(trackDuration / 2, 240);
            _logger.LogInformation("Requirement for scrobble: {ScrobbleReqirement} seconds", scrobbleRequirement);
            if (playbackTime.TotalSeconds > scrobbleRequirement)
            {
                ScrobbleTrack(_lastPlayed.Value.Track, _lastPlayed.Value.Timestamp.ToUnixTimeSeconds());
            }
            else
            {
                _logger.LogInformation("Track not played for long enough, skipping scrobble.");
            }
        }
        _lastPlayed = (e.Track, DateTimeOffset.UtcNow);
    }

    public void RegisterEventHandlers()
    {
        _playbackEvents.TrackPlaybackEvent += Scrobble;
    }

    public void UnregisterEventHandlers()
    {
        _playbackEvents.TrackPlaybackEvent -= Scrobble;
    }
}
```

The plugin brings some dependencies, a configuration file, a logger configured by the plugin host and access to a host service via the service proxy.

Then finally, the [Last.fm](http://Last.fm) plugin exposes this controller for configuration.

```csharp
public class LastFmController : PluginBaseController
{
    private readonly ILastFmService _lastFmService;

    public LastFmController(IServiceProxy serviceProxy)
    {
        _lastFmService = serviceProxy.GetService<ILastFmService>();
    }

    [HttpGet]
    [Route("authorize")]
    public ActionResult AuthorizeUser()
    {
        var apiKey = _lastFmService.GetApiKey();
        return Redirect($"https://last.fm/api/auth?api_key={apiKey}&cb={Request.Scheme}://{Request.Host}/api/plugin/lastfm/setToken");
    }

    [HttpGet]
    [Route("setToken")]
    public ActionResult SetUserToken([FromQuery] string token)
    {
        _lastFmService.SetUserToken(token);
        return Ok();
    }
}
```

It’s up to the plugin author to decide how they want to persist data, so here I’ve simply chosen to keep session info in a configuration file. 

Note that the controller uses a service proxy to get the plugin service. This is because the controller is loaded on the host, while the plugin service lives in its own `ServiceProvider`. It's hard to unload assemblies if the types within them are in use, so I can simply remove the plugin's `ServiceProvider` instance and unload the assemblies that way.

From [Microsoft's documentation](https://learn.microsoft.com/en-us/dotnet/standard/assembly/unloadability) on assembly unloadability:

> Calling the AssemblyLoadContext.Unload method just initiates the unloading. The unloading finishes after:
> - No threads have methods from the assemblies loaded into the AssemblyLoadContext on their call stacks.
> - None of the types from the assemblies loaded into the AssemblyLoadContext, instances of those types, and the assemblies themselves are referenced by:
>   - References outside of the AssemblyLoadContext, except for weak references (WeakReference or WeakReference<T>).
>   - Strong garbage collector (GC) handles (GCHandleType.Normal or GCHandleType.Pinned) from both inside and outside of the AssemblyLoadContext.

```csharp
public void UnloadAll()
{
    foreach (var (plugin, serviceProvider) in _loadedPlugins)
    {
        UnregisterEventHandlersOnPlugin(serviceProvider);
        UnloadPlugin(plugin);
    }
}

private void UnloadPlugin(LoadedPlugin plugin)
{
    _logger.LogInformation("Unloading plugin: {PluginName}", plugin.Plugin.Name);

    _loadedPlugins.Remove(plugin, out _);
    plugin.PluginLoader.Unload();

    var applicationPartToRemove = _applicationPartManager.ApplicationParts.FirstOrDefault(a => a.Name == plugin.LoadedAssembly.GetName().Name);
    if (applicationPartToRemove != null)
    {
        _applicationPartManager.ApplicationParts.Remove(applicationPartToRemove);
        _logger.LogInformation("Unloading plugin controller.");
        _actionDescriptorChangeProvider.TokenSource.Cancel();
    }
}
```

Then, to use the plugin, simply compile it and copy the output to the application's plugin folder - and use the plugin loader to load the plugin.

## Outro
Finally, we're reached the end of the series. Thank you so much for reading - consider subscribing to my RSS feed if you'd like to keep up to date on my future articles.