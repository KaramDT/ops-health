import React from "react";
import { Route, Routes } from "react-router-dom";
import { PageLayout } from "@dynatrace/strato-components/layouts";
import { TimeframeProvider } from "./context/TimeframeContext";
import { SettingsProvider } from "./context/SettingsContext";
import { Header } from "./components/Header";
import { Home } from "./pages/Home";
import { CategoryDetail } from "./pages/CategoryDetail";

export const App = () => {
  return (
    <SettingsProvider>
      <TimeframeProvider>
        <PageLayout>
          <PageLayout.Header>
            <Header />
          </PageLayout.Header>
          <PageLayout.Content>
            <Routes>
              <Route path="/"            element={<Home />} />
              <Route path="/stores"      element={<CategoryDetail siteType="store" />} />
              <Route path="/warehouses"  element={<CategoryDetail siteType="warehouse" />} />
              <Route path="/offices"     element={<CategoryDetail siteType="office" />} />
              <Route path="/datacenters" element={<CategoryDetail siteType="datacenter" />} />
            </Routes>
          </PageLayout.Content>
        </PageLayout>
      </TimeframeProvider>
    </SettingsProvider>
  );
};
