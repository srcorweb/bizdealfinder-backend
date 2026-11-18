import { useState, useEffect } from "react";
import { redirect } from "@remix-run/node";
import {SaveBar} from '@shopify/app-bridge-react';
import { useAppBridge } from "@shopify/app-bridge-react";

import {
  useActionData,
  useLoaderData,
  useNavigation,
  useSubmit,
  useNavigate,
} from "@remix-run/react";
import { authenticate } from "../../shopify.server";
import {
  Box,
  Card,
  Bleed,
  Button,
  ChoiceList,
  Divider,
  EmptyState,
  Icon,
  InlineStack,
  InlineError,
  Layout,
  Page,
  Text,
  TextField,
  Thumbnail,
  BlockStack,
  PageActions,
  Badge,
  Grid,
  Select,
  Tooltip,
  Modal,
} from "@shopify/polaris";
import { QuestionCircleIcon, ViewIcon, HideIcon, FormsIcon } from "@shopify/polaris-icons";

import { sampleLocation, emptyLocation, LocationType, states, socialOptions, days } from "./defines";
import { LocationModel } from "app/models/Location.server";
import { SocialsBlock } from "./socials";
import { HrsBlock } from "./hrs";
import { LogoBlock } from "./logo";
import { MarkerBlock } from "../app.design/marker";
import { TagsBlock } from "./tags";

import { MapPreviewerRight } from "../app.design/preview_right";
import { locationCardDataType, defaultSettings } from "../app.design/defines";

import { formatTime, renderSource } from "app/components/Functions";
import { LoadingScreen } from 'app/components/LoadingScreen';
import { getSessionToken } from "@shopify/app-bridge/utilities";

export async function loader({ request, params }) {
  const { admin, session } = await authenticate.admin(request);
  const { shop, accessToken } = session;
  
  const authHeader = request.headers.get("authorization");
  const headers = {
    'Authorization': `${authHeader}`,
    'Content-Type': 'application/json'
  }

  let availableTags = [];
  try {
    const tagsResponse = await fetch(`${process.env.API_DOMAIN}/api/AppSettings/SearchFilters`, {
      headers
    });
    if (tagsResponse.ok) {
      const tagsData = await tagsResponse.json();
      availableTags = tagsData.map(tag => tag.tag);
    }
  } catch (error) {
    console.error('Failed to fetch tags:', error);
  }

  let currentPlan = 'basic';
  let planLimits = { maxLocations: 10 };
  let currentLocationsCount = 0;

  if (params.id === "new") {
    try {
      const [subscriptionData, locationsData] = await Promise.all([
        fetch(`${process.env.API_DOMAIN}/api/Subscription`, {
          headers
        }).then(res => res.json()).catch(() => null),
        fetch(`${process.env.API_DOMAIN}/api/Locations`, {
          headers
        }).then(res => res.json()).catch(() => [])
      ]);

      // Determine current plan and limits
      if (subscriptionData && subscriptionData.plan) {
        currentPlan = subscriptionData.plan.planName.toLowerCase();
        planLimits = { maxLocations: subscriptionData.plan.maxLocations };
        
        // Set maxLocations to 0 for unlimited plans
        if (currentPlan === 'business plus') {
          planLimits.maxLocations = 0; // 0 means unlimited
        }
      }

      currentLocationsCount = Array.isArray(locationsData) ? locationsData.length : 0;
    } catch (error) {
      console.error('Failed to fetch plan data:', error);
    }

    let universalMarkerSettings = null;
    try {
      const universalResponse = await fetch(`${process.env.API_DOMAIN}/api/MapDesigner`, {
        headers
      });
      if (universalResponse.ok) {
        const universalData = await universalResponse.json();
        universalMarkerSettings = {
          custom: universalData.markerCustom || '',
          preset: universalData.markerPreset || 'default',
          color: universalData.markerColor || '#000000',
          height: universalData.markerHeight || '40',
          width: universalData.markerWidth || '30'
        };
      }
    } catch (error) {
      console.error('Failed to fetch universal marker settings:', error);
    }

    return Response.json({
      ...emptyLocation,
      marker: universalMarkerSettings || emptyLocation.marker,
      availableTags,
      currentPlan,
      planLimits,
      currentLocationsCount,
      shop: shop
    });
  } else {
    const response = await fetch(`${process.env.API_DOMAIN}/api/Locations/${params.id}`, {
      headers
    });
    
    if (!response.ok) {
      throw redirect(`/app/locations`);
    }

    const location = await response.json();

    const originalTags = location.tags || [];
    const cleanedTags = originalTags.filter(tag => availableTags.includes(tag));

    if (originalTags.length !== cleanedTags.length) {
      try {
        const updatedLocation = {
          ...location,
          tags: cleanedTags
        };
        
        const updateResponse = await fetch(`${process.env.API_DOMAIN}/api/Locations`, {
          method: 'PUT',
          headers: {
            'Authorization': `${authHeader}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(updatedLocation)
        });
        
        if (updateResponse.ok) {
          const updatedLocationData = await updateResponse.json();
          return Response.json({
            ...updatedLocationData,
            availableTags
          });
        }
      } catch (error) {
        console.error('Failed to update location tags:', error);
      }
    }
    
    return Response.json({
      ...location,
      tags: cleanedTags,
      availableTags,
      shop: shop
    });
  }
}

export async function action({ request, params }) {
  const { admin, session } = await authenticate.admin(request);
  const { shop, accessToken } = session;

  const authHeader = request.headers.get("authorization");
  const headers = {
    'Authorization': `${authHeader}`,
    'Content-Type': 'application/json'
  };

  /** @type {any} */
  const parsedData = {
    ...Object.fromEntries(await request.formData()),
    shop,
    params
  };

  let data = {...parsedData};

  if (!data.action) {
    const daysOfWeek = [
      "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"
    ];

    data = {
      ...parsedData,
      address: JSON.parse(parsedData?.address),
      socials: JSON.parse(parsedData?.socials ? parsedData?.socials : []),
      hrs: JSON.parse(parsedData?.hrs),
      marker: JSON.parse(parsedData?.marker),
      tags: JSON.parse(parsedData?.tags),
      visible: parsedData?.visible === "true"
    };
  
    data.hrs = data.hrs.map((entry, index) => ({
      ...entry,
      dayOfWeek: entry.dayOfWeek || daysOfWeek[index]
    }));
  }

  if (data.action === "delete") {
    // TODO - delete action
    const response = await fetch(`${process.env.API_DOMAIN}/api/Locations/${params.id}`, {
      method: 'DELETE',
      headers
    });
    
    if (!response) {
      const errorData = await response.json();
      return { errors: errorData };
    }
    
    return redirect("/app/locations");
  }

  const errors = LocationModel.validate(data);

  if (params.id === "new") {
    try {
      const [subscriptionData, locationsData] = await Promise.all([
        fetch(`${process.env.API_DOMAIN}/api/Subscription`, {
          headers
        }).then(res => res.json()).catch(() => null),
        fetch(`${process.env.API_DOMAIN}/api/Locations`, {
          headers
        }).then(res => res.json()).catch(() => [])
      ]);

      let currentPlan = 'basic';
      let maxLocations = 10;

      if (subscriptionData && subscriptionData.plan) {
        currentPlan = subscriptionData.plan.planName.toLowerCase();
        maxLocations = subscriptionData.plan.maxLocations;
      }

      const currentLocationsCount = Array.isArray(locationsData) ? locationsData.length : 0;

      if (currentPlan !== 'business plus' && maxLocations > 0 && currentLocationsCount >= maxLocations) {
        errors.planLimit = `You've reached the locations limit (${maxLocations}) on your ${currentPlan} plan. Please upgrade to add more locations.`;
      }
    } catch (error) {
      console.error('Failed to check plan limits:', error);
    }
  }
  
  // TODO - Add or Update location
  if (Object.keys(errors).length > 0) {
    return { errors };
  }


  let response;
  if (params.id === "new") {
    response = await fetch(`${process.env.API_DOMAIN}/api/Locations`, {
      method: 'POST',
      headers,
      body: JSON.stringify(data)
    });
   
  } else {
    response = await fetch(`${process.env.API_DOMAIN}/api/Locations`, {
      method: 'PUT',
      headers,
      body: JSON.stringify(data)
    });
  }
  
  if (!response) {
    const errorData = await response.json();
    return { errors: errorData };
  }

  const responseData = await response.json();
  return { responseData };
}

export default function Index() {
  
  const shopify = useAppBridge();
  const actionData = useActionData();
  const errors = actionData?.errors || {};
  
  const locationData = useLoaderData();
  const { availableTags, currentPlan, planLimits, currentLocationsCount, shop, ...locationWithoutTags } = locationData;
  const location:LocationType = locationWithoutTags;

  const isPlanLimitExceeded = () => {
    if (!currentPlan || !planLimits || currentLocationsCount === undefined) {
      return false;
    }

    if (currentPlan === 'business plus' || planLimits.maxLocations === 0) {
      return false;
    }

    return currentLocationsCount >= planLimits.maxLocations;
  };

  const isNewLocation = location.id === undefined || location.id === null;
  
  const [formState, setFormState] = useState(location);
  const [cleanFormState, setCleanFormState] = useState(location);
  const isDirty = JSON.stringify(formState) !== JSON.stringify(cleanFormState);
  const navigate = useNavigate();
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [isMarkerCustomized, setIsMarkerCustomized] = useState(false);

  useEffect(() => {
    if (location.marker && locationData.marker) {
      const hasCustomMarker = (
        location.marker.preset !== locationData.marker.preset ||
        location.marker.color !== locationData.marker.color ||
        location.marker.height !== locationData.marker.height ||
        location.marker.width !== locationData.marker.width ||
        location.marker.custom !== locationData.marker.custom
      );
      setIsMarkerCustomized(hasCustomMarker);
    }
  }, [location.marker, locationData.marker]);

  const [settings, setSettings] = useState(defaultSettings);

  const nav = useNavigation();
  const isSaving =
    nav.state === "submitting" && nav.formData?.get("action") !== "delete";
  const isDeleting =
    nav.state === "submitting" && nav.formData?.get("action") === "delete";
  const isLoading = nav.state === "loading";

  const submit = useSubmit();
  function handleSave() {
    // TODO
    const data = new FormData();

    Object.entries(formState).forEach(([key, value]) => {
      if (typeof value === 'object' && value !== null) {
        data.append(key, JSON.stringify(value));
      } else {
        data.append(key, value as string);
      }
    });

    setCleanFormState({ ...formState });
    submit(data, { method: "post" });
  }

  function handleDelete() {
    const data = new FormData();
    data.append("action", "delete");
    
    submit(data, { method: "post" });
    setDeleteModalOpen(false);
  }

  const toggleVisible = () => {
    setFormState((formState) => {return {...formState, visible:!formState.visible}});
  }

  const visibleToggle = (formState.visible) ? (
    <Badge tone="success"><Button icon={ViewIcon} tone="success" variant="plain" onClick={toggleVisible}>Visible</Button></Badge>
  ) : (
    <Badge><Button icon={HideIcon} variant="plain" onClick={toggleVisible}>Hidden</Button></Badge>
  );

  const handleUpgradePlan = () => {
    const shopDomain = shop || shopify.config?.shop;
    if (shopDomain) {
      const storeHandle = shopDomain.includes('.myshopify.com') 
        ? shopDomain.replace('.myshopify.com', '')
        : shopDomain;
      const pricingUrl = `https://admin.shopify.com/store/${storeHandle}/charges/dynamic-store-locator/pricing_plans`;
      
      if (window.top) {
        window.top.location.href = pricingUrl;
      } else {
        window.location.href = pricingUrl;
      }
    }
  };

  const UpdateAction = (field: string, value: any) => {
    setFormState({...formState, [field]: value});
    if (field == 'marker') {
      setSettings({...settings, marker: value});
      setIsMarkerCustomized(true);
    }
  }

  const previewData = ():locationCardDataType => {
    const data = {
      hrs: formState.hrs.map((x, i) => [
        days[i].substring(0,3), 
        x.from + '  –  ' + x.to,
        x.visible
      ]),
      location: formState.location,
      address: {
        address1: formState.address.address1,
        address2: formState.address.address2,
        city: formState.address.city,
        state: formState.address.state,
        zipcode: formState.address.zipcode
      },
      phone: formState.phone,
      url: formState.website,
      directions: formState.directions,
      logo: formState.logo,
      socials: formState.socials ? formState.socials : []
    };
    return data;
  }

  useEffect(() => {
    if (isDirty) {
      shopify.saveBar.show('location-save-bar');
    } else {
      shopify.saveBar.hide('location-save-bar');
    }
  }, [isDirty]);

  return (
    <>
      <Page 
        backAction={{
          content: 'All Locations', 
          onAction: () => {
            if (!document.getElementById('location-save-bar')?.showing) navigate(`../`);
          },
        }}
        title="Location Editor"
        titleMetadata={visibleToggle}
        compactTitle
        primaryAction={{
          content: 'Save', 
          disabled: !isDirty || (isNewLocation && isPlanLimitExceeded()),
          loading: isSaving,
          onAction: handleSave
        }}
        secondaryActions={[
          {
            content: 'Delete',
            accessibilityLabel: 'Delete location',
            destructive: true,
            onAction: () => setDeleteModalOpen(true),
          }
        ]}
      >
        {isLoading && (<LoadingScreen />)}

        {isNewLocation && isPlanLimitExceeded() && (
          <Box paddingBlockEnd="400">
            <Card>
              <BlockStack gap="200">
                <Text as="h4" variant="headingMd" tone="critical">
                  You've reached the locations limit on your current plan. You must upgrade in order to add more locations.
                </Text>
                <Text as="p" variant="bodyMd" tone="subdued">
                  Current locations: {currentLocationsCount || 0} / {planLimits?.maxLocations === 0 ? 'Unlimited' : planLimits?.maxLocations}
                </Text>
                <Box>
                  <Button onClick={handleUpgradePlan}>Upgrade My Plan</Button>
                </Box>
              </BlockStack>
            </Card>
          </Box>
        )}

        {errors.planLimit && (
          <Box paddingBlockEnd="400">
            <Card tone="critical">
              <BlockStack gap="200">
                <Text as="p" tone="critical">{errors.planLimit}</Text>
                <Box>
                  <Button onClick={handleUpgradePlan}>Upgrade My Plan</Button>
                </Box>
              </BlockStack>
            </Card>
          </Box>
        )}

        <Grid>
          <Grid.Cell columnSpan={{xs: 6, sm: 4, md: 4, lg: 8, xl: 8}}>
         {/* <form
            data-save-bar
            onreset="console.log('discarding')"
          > */}
            <BlockStack gap="400">

              <Card>
                <BlockStack gap="200">
                  <InlineStack align="space-between">
                    <BlockStack gap="100">
                      <Text as="h4" variant="headingMd">Location Information</Text>
                      <Text as="p" variant="bodySm" tone="subdued">Customize your location information</Text>
                    </BlockStack>
                    <BlockStack gap="100" inlineAlign="end">
                      <Box>
                        {renderSource(formState.source)}
                      </Box>
                      {formState.updated && (<Text as="p" variant="bodySm" tone="subdued">Last Synced {formatTime(formState.updated)}</Text>)}
                    </BlockStack>
                  </InlineStack>

                  <Box padding="200">
                    <BlockStack gap="200">
                      <TextField
                        label="Location Name"
                        requiredIndicator
                        type="text"
                        value={formState.location}
                        onChange={(newValue: string) => setFormState({...formState, location: newValue})}
                        autoComplete="off"
                        error={errors.location}
                      />

                      <TextField
                        label="Address1"
                        requiredIndicator
                        type="text"
                        value={formState.address.address1}
                        onChange={(newValue: string) => setFormState({...formState, address:{...formState.address, address1:newValue}})}
                        autoComplete="address-line1"
                        error={errors['address.address1']}
                      />

                      <TextField
                        label="Address2"
                        type="text"
                        value={formState.address.address2}
                        onChange={(newValue: string) => setFormState({...formState, address:{...formState.address, address2:newValue}})}
                        autoComplete="address-line2"
                      />

                      <Grid>
                        <Grid.Cell columnSpan={{xs:6, sm:6, md:2, lg:5}}>
                          <TextField
                            label="City"
                            requiredIndicator
                            type="text"
                            value={formState.address.city}
                            onChange={(newValue: string) => setFormState({...formState, address:{...formState.address, city:newValue}})}
                            autoComplete="address-level2"
                            error={errors['address.city']}
                          />
                        </Grid.Cell>

                        <Grid.Cell columnSpan={{xs:6, sm:3, md:2, lg:2}}>
                          <Select
                            label="State"
                            requiredIndicator
                            options={states.map((x, i) => ({label: x.value, value: x.value}))}
                            value={formState.address.state}
                            onChange={(newValue: string) => setFormState({...formState, address:{...formState.address, state:newValue}})}
                            error={errors['address.state']}
                          />
                        </Grid.Cell>

                        <Grid.Cell columnSpan={{xs:6, sm:3, md:2, lg:5}}>
                          <TextField
                            label="Zip Code"
                            requiredIndicator
                            type="text"
                            value={formState.address.zipcode}
                            onChange={(newValue: string) => setFormState({...formState, address:{...formState.address, zipcode:newValue}})}
                            autoComplete="postal-code"
                            error={errors['address.zipcode']}
                          />
                        </Grid.Cell>
                      </Grid>

                      <Grid>
                        <Grid.Cell columnSpan={{xs:6, sm:3, md:3, lg:6}}>
                          <TextField
                            label="Phone Number"
                            type="tel"
                            value={formState.phone}
                            onChange={(newValue: string) => setFormState({...formState, phone:newValue})}
                            autoComplete="tel"
                          />
                        </Grid.Cell>
                        <Grid.Cell columnSpan={{xs:6, sm:3, md:3, lg:6}}>
                          <TextField
                            label="Website URL"
                            type="url"
                            value={formState.website}
                            onChange={(newValue: string) => setFormState({...formState, website:newValue})}
                            autoComplete="url"
                          />
                        </Grid.Cell>
                      </Grid>

                      <TextField
                        label="Directions"
                        type="url"
                        value={formState.directions}
                        onChange={(newValue: string) => setFormState({...formState, directions:newValue})}
                        autoComplete="url"
                      />

                    </BlockStack>
                  </Box>
                  
                </BlockStack>
              </Card>

              <SocialsBlock socials={formState.socials} update={UpdateAction} key={JSON.stringify(formState.socials)}/>

              <HrsBlock hrs={formState.hrs} update={UpdateAction} key={JSON.stringify(formState.hrs)}/>

              <LogoBlock logo={formState.logo} update={UpdateAction}/>

              <Card>
                <BlockStack gap="200">
                  <InlineStack align="space-between">
                    <BlockStack gap="100">
                      <Text as="h4" variant="headingMd">Location Marker</Text>
                      <Text as="p" variant="bodySm">
                        {isMarkerCustomized 
                          ? "Using custom marker settings for this location." 
                          : "Using universal marker from Map Designer settings."
                        }
                      </Text>
                    </BlockStack>
                    <InlineStack gap="100" blockAlign="center">
                      {!isMarkerCustomized && (
                        <Button onClick={() => setIsMarkerCustomized(true)}>
                          Customize Marker
                        </Button>
                      )}
                      {isMarkerCustomized && (
                        <Button 
                          variant="plain" 
                          onClick={() => {
                            // Reset to universal marker settings
                            const universalMarker = locationData.marker || emptyLocation.marker;
                            setFormState({
                              ...formState, 
                              marker: universalMarker
                            });
                            setSettings({...settings, marker: universalMarker});
                            setIsMarkerCustomized(false);
                          }}
                        >
                          Use Universal Marker
                        </Button>
                      )}
                    </InlineStack>
                  </InlineStack>

                  {isMarkerCustomized && (
                    <MarkerBlock 
                      settings={formState.marker} 
                      update={UpdateAction} 
                      section="location" 
                    />
                  )}

                </BlockStack>
              </Card>

              <TagsBlock tags={formState.tags} availableTags={availableTags} update={UpdateAction} key={JSON.stringify(formState.tags)} />

            </BlockStack>
          {/* </form> */}
          </Grid.Cell>
          <Grid.Cell columnSpan={{xs: 6, sm: 2, md: 2, lg: 4, xl: 4}}>
            <div className="design-previewer design-previewer--location" style={{position:'fixed'}}>
              <MapPreviewerRight settings={settings} data={previewData()} />
            </div>
          </Grid.Cell>
        </Grid>

        <SaveBar id="location-save-bar">
          <button variant="primary" onClick={handleSave}></button>
          <button id="discard-button" onClick={() => {
            setFormState(cleanFormState);
          console.log('Discarding');
            shopify.saveBar.hide('location-save-bar');
          }}></button>
        </SaveBar>

      </Page>

      <Modal
        open={deleteModalOpen}
        onClose={() => setDeleteModalOpen(false)}
        title="Delete Location"
        primaryAction={{
          content: 'Delete',
          destructive: true,
          loading: isDeleting,
          onAction: handleDelete,
        }}
        secondaryActions={[
          {
            content: 'Cancel',
            onAction: () => setDeleteModalOpen(false),
          },
        ]}
      >
        <Modal.Section>
          <Text>
            Are you sure you want to delete the location "{formState.location}"? This action cannot be undone.
          </Text>
        </Modal.Section>
      </Modal>
    </>
  );
}
